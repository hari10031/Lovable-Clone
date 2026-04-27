import { Sandbox } from "@e2b/code-interpreter";
import OpenAI from "openai";
import { z } from "zod";

import {
  AVAILABLE_CODE_MODELS,
  DEFAULT_CODE_MODEL,
  SANDBOX_TIMEOUT_IN_MS,
} from "@/constants";
import prisma from "@/lib/prisma";
import { JSON_GENERATION_PROMPT, JSON_REPAIR_PROMPT } from "@/prompt";
import { FileCollection } from "@/types";
import { inngest } from "./client";
import {
  buildConversationTranscript,
  extractImportedPackages,
  extractJsonObject,
  getSandbox,
  isSafeRelativePath,
  normalizeRelativePath,
  normalizeStoredFiles,
  sanitizePackageNames,
  serializeFilesForPrompt,
} from "./utils";

const E2B_TEMPLATE =
  process.env.E2B_TEMPLATE_ID ??
  process.env.E2B_TEMPLATE_NAME ??
  process.env.E2B_TEMPLATE ??
  "vibe-nextjs-bek-2";

const INTERNAL_METADATA_PATH = ".lovable/metadata.json";
const SANDBOX_BASE_PACKAGES = [
  "clsx",
  "tailwind-merge",
  "class-variance-authority",
  "lucide-react",
] as const;
const SANDBOX_BOOTSTRAP_FILES: FileCollection = {
  "lib/utils.ts": `import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`,
};

const generatedProjectSchema = z.object({
  title: z.string().trim().min(1).default("Project Update"),
  response: z.string().trim().min(1).default("Built the requested app."),
  summary: z.string().trim().min(1).default("Built the requested app."),
  packages: z.array(z.string()).default([]),
  files: z
    .array(
      z.object({
        path: z.string().trim().min(1),
        content: z.string(),
      })
    )
    .default([]),
  deletedFiles: z.array(z.string()).default([]),
});

const projectMetadataSchema = z.object({
  installedPackages: z.array(z.string()).default([]),
});

type GeneratedProject = z.infer<typeof generatedProjectSchema>;
type ProjectMetadata = z.infer<typeof projectMetadataSchema>;
type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};
type CommandOutcome = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const MAX_COMPLETION_TOKENS = 16384;
const COMPLETION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per attempt

type ProviderName = "cerebras" | "nvidia" | "featherless";
type ProviderConfig = {
  name: ProviderName;
  apiKey: string;
  baseURL: string;
  // Map a generic / cross-provider model id to this provider's id.
  // Returning null means the provider can't serve that model; skip it.
  resolveModel: (modelId: string) => string | null;
  // Stable identifier used in logs (e.g. "cerebras#1", "cerebras#2").
  label: string;
};

// Loose mapping from "logical" intents to each provider's actual model id.
// When a request fails on the preferred provider (rate-limit, 5xx, etc.)
// the fallback provider runs the same prompt with its closest equivalent.
const CEREBRAS_MODEL_MAP: Record<string, string> = {
  // identity
  "qwen-3-235b-a22b-instruct-2507": "qwen-3-235b-a22b-instruct-2507",
  "gpt-oss-120b": "gpt-oss-120b",
  "zai-glm-4.7": "zai-glm-4.7",
  "llama3.1-8b": "llama3.1-8b",
};

const NVIDIA_FALLBACK_FOR_CEREBRAS: Record<string, string> = {
  "qwen-3-235b-a22b-instruct-2507": "qwen/qwen3-next-80b-a3b-instruct",
  "gpt-oss-120b": "openai/gpt-oss-120b",
  "zai-glm-4.7": "z-ai/glm4.7",
  "llama3.1-8b": "meta/llama-3.1-8b-instruct",
};

// Collect every Cerebras key from env. Recognized names (in priority order):
//   CEREBRAS_API_KEY, CEREBRAS_API_KEY_2, CEREBRAS_API_KEY_3, ...
// plus any CEREBRAS_API_KEY_<N> for N up to 9. Empty / missing keys are skipped.
function collectCerebrasKeys(): string[] {
  const keys: string[] = [];
  const primary = process.env.CEREBRAS_API_KEY?.trim();
  if (primary) keys.push(primary);

  for (let i = 2; i <= 9; i++) {
    const key = process.env[`CEREBRAS_API_KEY_${i}`]?.trim();
    if (key) keys.push(key);
  }

  // Dedupe in case the same key is set twice.
  return Array.from(new Set(keys));
}

function buildProviderChain(): ProviderConfig[] {
  const chain: ProviderConfig[] = [];

  const cerebrasKeys = collectCerebrasKeys();
  cerebrasKeys.forEach((apiKey, index) => {
    chain.push({
      name: "cerebras",
      apiKey,
      baseURL: "https://api.cerebras.ai/v1",
      resolveModel: (id) => CEREBRAS_MODEL_MAP[id] ?? null,
      // Used only for logging so each key is identifiable.
      label: index === 0 ? "cerebras#1" : `cerebras#${index + 1}`,
    });
  });

  if (process.env.NVIDIA_API_KEY) {
    chain.push({
      name: "nvidia",
      apiKey: process.env.NVIDIA_API_KEY,
      baseURL: "https://integrate.api.nvidia.com/v1",
      resolveModel: (id) => NVIDIA_FALLBACK_FOR_CEREBRAS[id] ?? id,
      label: "nvidia",
    });
  }

  if (process.env.FEATHERLESS_API_KEY) {
    chain.push({
      name: "featherless",
      apiKey: process.env.FEATHERLESS_API_KEY,
      baseURL: "https://api.featherless.ai/v1",
      resolveModel: (id) => id,
      label: "featherless",
    });
  }

  if (!chain.length) {
    throw new Error(
      "No LLM provider configured. Set CEREBRAS_API_KEY (preferred), NVIDIA_API_KEY, or FEATHERLESS_API_KEY."
    );
  }

  return chain;
}

function makeOpenAIClient(provider: ProviderConfig) {
  return new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    timeout: COMPLETION_TIMEOUT_MS,
    maxRetries: 0,
  });
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { status?: number }).status;
}

class RateLimitError extends Error {
  constructor(
    public providerName: ProviderName,
    public modelId: string,
    message?: string
  ) {
    super(
      message ??
      `${providerName} returned HTTP 429 (rate-limited) for model "${modelId}".`
    );
    this.name = "RateLimitError";
  }
}

function isWritableProjectPath(path: string) {
  if (!isSafeRelativePath(path)) {
    return false;
  }

  if (
    path.startsWith(".next/") ||
    path.startsWith("node_modules/") ||
    path.startsWith(".git/")
  ) {
    return false;
  }

  if (
    path === "package.json" ||
    path === "package-lock.json" ||
    path === "pnpm-lock.yaml" ||
    path === "yarn.lock" ||
    path === "bun.lockb"
  ) {
    return false;
  }

  if (/\.(css|scss|sass)$/.test(path)) {
    return false;
  }

  return true;
}

function getVisibleProjectFiles(files: FileCollection) {
  return Object.fromEntries(
    Object.entries(files).filter(([path]) => path !== INTERNAL_METADATA_PATH)
  );
}

function readProjectMetadata(files: FileCollection): ProjectMetadata {
  const rawMetadata = files[INTERNAL_METADATA_PATH];

  if (!rawMetadata) {
    return { installedPackages: [] };
  }

  try {
    return projectMetadataSchema.parse(JSON.parse(rawMetadata));
  } catch {
    return { installedPackages: [] };
  }
}

function withProjectMetadata(
  files: FileCollection,
  installedPackages: string[]
): FileCollection {
  const nextFiles = { ...files };
  nextFiles[INTERNAL_METADATA_PATH] = JSON.stringify(
    {
      installedPackages: sanitizePackageNames(installedPackages),
    },
    null,
    2
  );

  return nextFiles;
}

// Auto-fix common output mistakes that would otherwise break the build:
// 1. "use client;" without surrounding quotes (must be the directive '"use client";')
// 2. "use server;" without surrounding quotes
// 3. Stray BOM at start of file
function repairFileContent(raw: string): string {
  let content = raw.replace(/^\uFEFF/, "");

  // Match a bare directive on the first non-empty line: `use client;` or `use client`
  // and wrap it in double quotes. Only touches the very first non-empty line.
  content = content.replace(
    /^(\s*)(use (client|server))\s*;?\s*$/m,
    (_match, leading: string, directive: string) => `${leading}"${directive}";`
  );

  return content;
}

// If the model wrote components but forgot to update app/page.tsx, generate
// a minimal page that imports and renders the most likely component. Without
// this, the sandbox keeps showing the default Next.js template even though
// new files were written.
function ensureAppPageTsx(nextFiles: Map<string, string>): boolean {
  if (nextFiles.has("app/page.tsx")) return false;

  // Pick the first .tsx file that looks like a component (not a layout).
  const candidates = [...nextFiles.entries()].filter(([path]) =>
    path.endsWith(".tsx") &&
    !path.endsWith("/layout.tsx") &&
    path !== "app/layout.tsx"
  );
  if (!candidates.length) return false;

  const [componentPath, componentSource] = candidates[0];

  // Detect export style and component name.
  let componentName: string | null = null;
  let importLine = "";
  const defaultFn = componentSource.match(
    /export\s+default\s+function\s+(\w+)/
  );
  const defaultClass = componentSource.match(
    /export\s+default\s+class\s+(\w+)/
  );
  const defaultIdent = componentSource.match(/export\s+default\s+(\w+)\s*;?\s*$/m);
  const namedFn = componentSource.match(/export\s+function\s+(\w+)/);
  const namedConst = componentSource.match(/export\s+const\s+(\w+)\s*=/);

  // Build a relative import path from app/page.tsx to the target component.
  // Always use relative paths (not the "@/" alias) to be tsconfig-independent.
  const stripExt = componentPath.replace(/\.tsx$/, "");
  const importTarget = stripExt.startsWith("app/")
    ? "./" + stripExt.slice("app/".length)
    : "../" + stripExt;

  if (defaultFn) {
    componentName = defaultFn[1];
    importLine = `import ${componentName} from "${importTarget}";`;
  } else if (defaultClass) {
    componentName = defaultClass[1];
    importLine = `import ${componentName} from "${importTarget}";`;
  } else if (defaultIdent) {
    componentName = defaultIdent[1];
    importLine = `import ${componentName} from "${importTarget}";`;
  } else if (namedFn) {
    componentName = namedFn[1];
    importLine = `import { ${componentName} } from "${importTarget}";`;
  } else if (namedConst) {
    componentName = namedConst[1];
    importLine = `import { ${componentName} } from "${importTarget}";`;
  } else {
    // Last-resort fallback: derive name from filename.
    componentName =
      componentPath.split("/").pop()?.replace(/\.tsx$/, "")?.replace(/[^A-Za-z0-9]/g, "") ??
      "Component";
    importLine = `import ${componentName} from "${importTarget}";`;
  }

  const generatedPage = `${importLine}\n\nexport default function Page() {\n  return <${componentName} />;\n}\n`;

  nextFiles.set("app/page.tsx", generatedPage);
  console.warn(
    `[code-agent] auto-generated app/page.tsx that renders <${componentName}/> from ${componentPath}`
  );
  return true;
}

function parseGeneratedProject(rawOutput: string): GeneratedProject {
  const json = extractJsonObject(rawOutput);

  if (!json) {
    throw new Error("The model did not return a JSON object.");
  }

  const parsed = generatedProjectSchema.parse(JSON.parse(json));
  const nextFiles = new Map<string, string>();
  const droppedPaths: string[] = [];

  for (const file of parsed.files) {
    const path = normalizeRelativePath(file.path);

    if (!isWritableProjectPath(path)) {
      droppedPaths.push(path);
      continue;
    }

    nextFiles.set(path, repairFileContent(file.content));
  }

  if (droppedPaths.length) {
    console.warn(
      `[code-agent] dropped ${droppedPaths.length} unsupported path(s) from model output:`,
      droppedPaths
    );
  }

  // Sanity guard: if the model produced output but every single file got
  // filtered (e.g. it returned a Vite/CRA project), refuse so the user sees
  // a clear error instead of the default Next.js template.
  if (parsed.files.length > 0 && nextFiles.size === 0) {
    throw new Error(
      `The model produced ${parsed.files.length} file(s), but ALL were filtered out as unsupported paths ` +
      `(likely Vite/CRA boilerplate). Dropped: ${droppedPaths.slice(0, 10).join(", ")}${droppedPaths.length > 10 ? ", ..." : ""
      }. The pipeline only accepts Next.js App Router files under app/, components/, lib/, etc.`
    );
  }

  // Auto-bridge: if the model wrote components but forgot app/page.tsx,
  // synthesize a minimal page that renders the first component.
  ensureAppPageTsx(nextFiles);

  const deletedFiles = Array.from(
    new Set(
      parsed.deletedFiles
        .map((path) => normalizeRelativePath(path))
        .filter(isWritableProjectPath)
    )
  );

  return {
    title: parsed.title,
    response: parsed.response,
    summary: parsed.summary,
    packages: sanitizePackageNames(parsed.packages),
    files: Array.from(nextFiles.entries()).map(([path, content]) => ({
      path,
      content,
    })),
    deletedFiles,
  };
}

function buildGeneratorInput({
  request,
  previousMessages,
  existingFiles,
  validationFeedback,
}: {
  request: string;
  previousMessages: ConversationMessage[];
  existingFiles: FileCollection;
  validationFeedback?: string;
}) {
  const sections = [
    `User request:\n${request}`,
    `Recent conversation:\n${buildConversationTranscript(previousMessages)}`,
    `Current project files:\n${serializeFilesForPrompt(
      getVisibleProjectFiles(existingFiles)
    )}`,
  ];

  if (validationFeedback) {
    sections.push(`Problems to fix:\n${validationFeedback}`);
  }

  return sections.join("\n\n");
}

async function requestGeneratedProject({
  model,
  prompt,
  userRequest,
  previousMessages,
  existingFiles,
  validationFeedback,
}: {
  model: string;
  prompt: string;
  userRequest: string;
  previousMessages: ConversationMessage[];
  existingFiles: FileCollection;
  validationFeedback?: string;
}) {
  const chain = buildProviderChain();

  // Only entries belonging to the top-priority provider type are eligible.
  // This means we rotate across all CEREBRAS_API_KEY_* on rate-limit, but we
  // never silently fall over to NVIDIA / Featherless — the user explicitly
  // chose to surface rate-limits instead of cross-provider fallback.
  const topProviderName = chain[0].name;
  const eligibleProviders = chain.filter((p) => p.name === topProviderName);

  const userPrompt = buildGeneratorInput({
    request: userRequest,
    previousMessages,
    existingFiles,
    validationFeedback,
  });

  const candidateLogicalIds = Array.from(new Set([model, DEFAULT_CODE_MODEL]));

  let lastError: unknown;
  let lastRateLimit: { providerName: ProviderName; modelId: string } | null = null;

  for (const provider of eligibleProviders) {
    const client = makeOpenAIClient(provider);
    const candidateModels = candidateLogicalIds
      .map((id) => ({ logical: id, resolved: provider.resolveModel(id) }))
      .filter(
        (c): c is { logical: string; resolved: string } => c.resolved !== null
      );

    if (!candidateModels.length) continue;

    let providerHitRateLimit = false;

    for (const { logical, resolved } of candidateModels) {
      // Attempt 1: strict JSON via response_format.
      try {
        const start = Date.now();
        const completion = await client.chat.completions.create({
          model: resolved,
          temperature: 0.2,
          max_tokens: MAX_COMPLETION_TOKENS,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: userPrompt },
          ],
        });

        console.log(
          `[code-agent] ${provider.label}:${resolved} json_object completed in ${(
            (Date.now() - start) /
            1000
          ).toFixed(1)}s`
        );

        return parseGeneratedProject(
          completion.choices[0]?.message?.content ?? ""
        );
      } catch (error) {
        lastError = error;
        if (getErrorStatus(error) === 429) {
          providerHitRateLimit = true;
          lastRateLimit = { providerName: provider.name, modelId: resolved };
          console.warn(
            `[code-agent] ${provider.label}:${resolved} hit 429 — rotating to next key if available`
          );
          // Skip the plain-mode retry on the same key — the bucket is empty.
          break;
        }
        console.warn(
          `[code-agent] ${provider.label}:${resolved} json_object attempt failed (logical=${logical}):`,
          error instanceof Error ? error.message : error
        );
      }

      // Attempt 2: same model without response_format (some providers/models reject it).
      try {
        const start = Date.now();
        const completion = await client.chat.completions.create({
          model: resolved,
          temperature: 0.2,
          max_tokens: MAX_COMPLETION_TOKENS,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: `${userPrompt}\n\nReturn raw JSON only.` },
          ],
        });

        console.log(
          `[code-agent] ${provider.label}:${resolved} plain completed in ${(
            (Date.now() - start) /
            1000
          ).toFixed(1)}s`
        );

        return parseGeneratedProject(
          completion.choices[0]?.message?.content ?? ""
        );
      } catch (error) {
        lastError = error;
        if (getErrorStatus(error) === 429) {
          providerHitRateLimit = true;
          lastRateLimit = { providerName: provider.name, modelId: resolved };
          console.warn(
            `[code-agent] ${provider.label}:${resolved} hit 429 (plain) — rotating to next key if available`
          );
          break;
        }
        console.warn(
          `[code-agent] ${provider.label}:${resolved} plain attempt failed (logical=${logical}):`,
          error instanceof Error ? error.message : error
        );
      }
    }

    if (!providerHitRateLimit) {
      // Non-rate-limit failure: don't rotate keys, just bail out.
      break;
    }
    // else: rate-limit on this key, try the next eligible provider entry.
  }

  // All eligible keys exhausted with rate-limits → surface clean error.
  if (lastRateLimit) {
    throw new RateLimitError(
      lastRateLimit.providerName,
      lastRateLimit.modelId,
      `All ${eligibleProviders.length} ${topProviderName} key(s) returned HTTP 429 for model "${lastRateLimit.modelId}".`
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to generate project files.");
}

function isCommandOutcome(value: unknown): value is CommandOutcome {
  return (
    !!value &&
    typeof value === "object" &&
    "exitCode" in value &&
    typeof value.exitCode === "number" &&
    "stdout" in value &&
    typeof value.stdout === "string" &&
    "stderr" in value &&
    typeof value.stderr === "string"
  );
}

async function runSandboxCommand(sandboxId: string, command: string) {
  const sandbox = await getSandbox(sandboxId);

  try {
    const result = await sandbox.commands.run(command);

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (isCommandOutcome(error)) {
      return error;
    }

    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function installPackages(sandboxId: string, packages: string[]) {
  // Defense-in-depth: re-sanitize at the install boundary so cached step
  // outputs from earlier runs (which may contain bogus entries like
  // "next/font/google") still get filtered before reaching `npm install`.
  const safePackages = sanitizePackageNames(packages);
  const dropped = packages.filter((p) => !safePackages.includes(p.trim()));
  if (dropped.length) {
    console.warn(
      `[code-agent] installPackages dropped ${dropped.length} bogus entries:`,
      dropped
    );
  }

  if (!safePackages.length) {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
  }

  return runSandboxCommand(
    sandboxId,
    `npm install ${safePackages.join(" ")} --yes`
  );
}

async function restoreFilesToSandbox(sandboxId: string, files: FileCollection) {
  const sandbox = await getSandbox(sandboxId);

  for (const [path, content] of Object.entries(SANDBOX_BOOTSTRAP_FILES)) {
    if (!files[path]) {
      await sandbox.files.write(path, content);
    }
  }

  if (!Object.keys(files).length) {
    return;
  }

  for (const [path, content] of Object.entries(files)) {
    await sandbox.files.write(path, content);
  }
}

async function applyGeneratedProject(
  sandboxId: string,
  currentFiles: FileCollection,
  generatedProject: GeneratedProject
) {
  const sandbox = await getSandbox(sandboxId);
  const nextFiles = { ...currentFiles };

  for (const path of generatedProject.deletedFiles) {
    try {
      await sandbox.files.remove(path);
    } catch {
      // Ignore missing files and continue deleting tracked state.
    }

    delete nextFiles[path];
  }

  for (const file of generatedProject.files) {
    await sandbox.files.write(file.path, file.content);
    nextFiles[file.path] = file.content;
  }

  return nextFiles;
}

// Make sure a Next.js dev server is listening on :3000 inside the sandbox.
// The E2B template is supposed to keep `npm run dev` running, but it can die
// after a corrupt file write, OOM, idle eviction, or a long-running sandbox.
// When that happens, the preview URL returns "Connection refused on port 3000"
// even though the sandbox itself is alive. This bootstraps it back.
async function ensureNextDevServer(sandboxId: string) {
  // Single shell pipeline:
  //   1. If something is already listening on :3000, exit 0.
  //   2. Otherwise, kill any zombie next processes, then start `npm run dev`
  //      detached with output redirected to /tmp/next-dev.log.
  //   3. Poll for up to 45s for :3000 to come up. Return 0 if it does.
  const script = `sh -lc '
set -e
cd /home/user 2>/dev/null || cd /app 2>/dev/null || true
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000 | grep -qE "^(2|3|4|5)"; then
  echo "next-dev already running"
  exit 0
fi
pkill -f "next dev" >/dev/null 2>&1 || true
pkill -f "next-server" >/dev/null 2>&1 || true
nohup npm run dev > /tmp/next-dev.log 2>&1 &
disown 2>/dev/null || true
for i in $(seq 1 45); do
  if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000 | grep -qE "^(2|3|4|5)"; then
    echo "next-dev started after $i s"
    exit 0
  fi
  sleep 1
done
echo "next-dev failed to listen on :3000 within 45s; tail of /tmp/next-dev.log:" >&2
tail -n 50 /tmp/next-dev.log >&2 2>/dev/null || true
exit 1
'`;

  return runSandboxCommand(sandboxId, script);
}

async function verifyProject(sandboxId: string) {
  const typecheck = await runSandboxCommand(sandboxId, "npx tsc --noEmit");
  const preview = await runSandboxCommand(
    sandboxId,
    `sh -lc 'for i in $(seq 1 20); do code=$(curl -s -o /tmp/lovable-preview.html -w "%{http_code}" http://127.0.0.1:3000); if [ "$code" = "200" ]; then if grep -qiE "Module not found|Build Error|Unhandled Runtime Error|Application error|Internal Server Error" /tmp/lovable-preview.html; then echo "Preview contains a Next.js error page" >&2; exit 1; fi; exit 0; fi; sleep 1; done; echo "Preview did not return HTTP 200" >&2; exit 1'`
  );

  const problems: string[] = [];

  if (typecheck.exitCode !== 0) {
    problems.push(
      `TypeScript validation failed:\n${(typecheck.stderr || typecheck.stdout).trim()}`
    );
  }

  if (preview.exitCode !== 0) {
    problems.push(
      `Preview validation failed:\n${(preview.stderr || preview.stdout).trim()}`
    );
  }

  return {
    ok: problems.length === 0,
    feedback: problems.join("\n\n"),
  };
}

function mergeGeneratedProject(
  base: GeneratedProject,
  next: GeneratedProject
): GeneratedProject {
  return {
    title: next.title || base.title,
    response: next.response || base.response,
    summary: next.summary || base.summary,
    packages: sanitizePackageNames([...base.packages, ...next.packages]),
    files: next.files.length > 0 ? next.files : base.files,
    deletedFiles: Array.from(
      new Set([...base.deletedFiles, ...next.deletedFiles])
    ),
  };
}

function buildInstallFailureFeedback(label: string, result: CommandOutcome) {
  if (result.exitCode === 0) {
    return "";
  }

  return `${label} package installation failed:\n${(
    result.stderr || result.stdout || "Unknown npm install error"
  ).trim()}`;
}

function combineFeedback(...parts: string[]) {
  return parts.filter(Boolean).join("\n\n");
}

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent" },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    const requestedModel = event.data.model || DEFAULT_CODE_MODEL;

    // Run sandbox creation, message history fetch, and latest-fragment fetch in
    // parallel. They have no dependencies on each other.
    const [sandboxResult, previousMessages, existingFiles] = await Promise.all([
      step.run("get-sandbox-id", async () => {
        try {
          const sandbox = await Sandbox.create(E2B_TEMPLATE);
          await sandbox.setTimeout(SANDBOX_TIMEOUT_IN_MS);
          return { kind: "ok" as const, sandboxId: sandbox.sandboxId };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown E2B error";

          // E2B rate-limit returns a message like "Rate limit exceeded, please
          // try again later." Surface this clearly instead of crashing the run.
          if (/rate.?limit/i.test(message)) {
            return { kind: "rate-limited" as const, message };
          }

          throw new Error(
            `Failed to create E2B sandbox using template "${E2B_TEMPLATE}". Set E2B_TEMPLATE_ID or E2B_TEMPLATE_NAME to a template your E2B API key can access. Original error: ${message}`
          );
        }
      }),
      step.run("get-previous-messages", async () => {
        const messages = await prisma.message.findMany({
          where: {
            projectId: event.data.projectId,
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 8,
        });

        return messages
          .reverse()
          .map(
            (message) =>
              ({
                role: message.role === "ASSISTANT" ? "assistant" : "user",
                content: message.content,
              }) satisfies ConversationMessage
          );
      }),
      step.run("get-latest-fragment", async () => {
        const latestFragment = await prisma.fragment.findFirst({
          where: {
            message: {
              projectId: event.data.projectId,
            },
          },
          orderBy: {
            updatedAt: "desc",
          },
        });

        return normalizeStoredFiles(latestFragment?.files);
      }),
    ]);

    if (sandboxResult.kind === "rate-limited") {
      const friendly = [
        `⚠️ The sandbox provider (E2B) is currently rate-limited. The build couldn't start.`,
        ``,
        `What you can do:`,
        `• Wait 1-2 minutes and resend your prompt — E2B free-tier limits reset quickly.`,
        `• Check your concurrent sandbox count at https://e2b.dev/dashboard. The free tier allows roughly 10 concurrent sandboxes; old ones must time out before new runs can start.`,
        `• If this keeps happening, upgrade your E2B plan or set E2B_TEMPLATE_ID to a higher-tier template.`,
        ``,
        `(Original error: ${sandboxResult.message})`,
      ].join("\n");

      await step.run("save-e2b-rate-limit-message", async () => {
        return prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: friendly,
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      });

      return {
        url: null,
        title: null,
        files: {},
        summary: friendly,
        validation: { ok: false, feedback: friendly },
        e2bRateLimited: true,
      };
    }

    const sandboxId = sandboxResult.sandboxId;
    const existingMetadata = readProjectMetadata(existingFiles);
    const trackedFiles = getVisibleProjectFiles(existingFiles);

    await step.run("restore-project-state", async () => {
      await restoreFilesToSandbox(sandboxId, existingFiles);

      const baseInstallResult = await installPackages(sandboxId, [
        ...SANDBOX_BASE_PACKAGES,
      ]);

      if (baseInstallResult.exitCode !== 0) {
        throw new Error(
          baseInstallResult.stderr ||
          baseInstallResult.stdout ||
          "Failed to install sandbox base packages."
        );
      }

      if (existingMetadata.installedPackages.length) {
        const installResult = await installPackages(
          sandboxId,
          existingMetadata.installedPackages
        );

        if (installResult.exitCode !== 0) {
          throw new Error(
            installResult.stderr || installResult.stdout || "npm install failed"
          );
        }
      }

      // Make sure Next dev is up. The E2B template should keep it running but
      // it can die after a corrupt write or long idle. Best-effort: log a
      // warning if revival fails — the verify step will catch fatal cases.
      const ensureResult = await ensureNextDevServer(sandboxId);
      if (ensureResult.exitCode !== 0) {
        console.warn(
          `[code-agent] ensureNextDevServer (restore) exit=${ensureResult.exitCode}: ${ensureResult.stderr || ensureResult.stdout}`
        );
      }

      return {
        restoredFiles: Object.keys(existingFiles).length,
        restoredPackages: existingMetadata.installedPackages.length,
        nextDevReady: ensureResult.exitCode === 0,
      };
    });

    const generationResult = await step.run(
      "generate-project-json",
      async () => {
        try {
          const project = await requestGeneratedProject({
            model: requestedModel,
            prompt: JSON_GENERATION_PROMPT,
            userRequest: event.data.value,
            previousMessages,
            existingFiles,
          });
          return { kind: "ok" as const, project };
        } catch (error) {
          if (error instanceof RateLimitError) {
            return {
              kind: "rate-limited" as const,
              providerName: error.providerName,
              modelId: error.modelId,
              detail: error.message,
            };
          }
          throw error;
        }
      }
    );

    if (generationResult.kind === "rate-limited") {
      const otherModels = AVAILABLE_CODE_MODELS.filter(
        (m: string) => m !== generationResult.modelId
      ).slice(0, 3);
      const friendly = [
        `⚠️ The AI provider (${generationResult.providerName}) is currently rate-limited for model "${generationResult.modelId}".`,
        ``,
        `Detail: ${generationResult.detail ?? "all configured API keys returned HTTP 429."}`,
        ``,
        `What you can do:`,
        `• Wait about 60 seconds, then resend your prompt — free-tier rate limits reset every minute.`,
        `• Or pick a different model from the dropdown and retry. Suggestions: ${otherModels.join(", ")}.`,
        `• If you only have one CEREBRAS_API_KEY in .env, add CEREBRAS_API_KEY_2 (and _3 ...) from a different Cerebras account for independent quotas.`,
      ].join("\n");

      await step.run("save-rate-limit-message", async () => {
        return prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: friendly,
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      });

      return {
        url: null,
        title: null,
        files: {},
        summary: friendly,
        validation: { ok: false, feedback: friendly },
        rateLimited: true,
      };
    }

    let generatedProject = generationResult.project;

    // Scan the actual generated source for bare-module imports and merge them
    // into the declared package list. Models routinely emit imports without
    // declaring them in `packages`, which used to surface as runtime
    // "Module not found" errors. Inferring from real imports closes that gap.
    const initialPackagesToInstall = (() => {
      const generatedFileMap: FileCollection = Object.fromEntries(
        generatedProject.files.map((f) => [f.path, f.content])
      );
      const inferred = extractImportedPackages({
        ...existingFiles,
        ...generatedFileMap,
      });
      return [...generatedProject.packages, ...inferred];
    })();

    const initialInstallResult = await step.run(
      "install-generated-packages",
      async () => {
        return installPackages(sandboxId, initialPackagesToInstall);
      }
    );
    const initialInstallFeedback = buildInstallFailureFeedback(
      "Generated",
      initialInstallResult
    );

    let finalFiles = await step.run("apply-generated-files", async () => {
      return applyGeneratedProject(sandboxId, existingFiles, generatedProject);
    });

    const initialVerification = await step.run("verify-project", async () => {
      // Make sure dev server is up before curling :3000. Fresh files written
      // a moment ago can knock it out — re-bootstrap if needed.
      await ensureNextDevServer(sandboxId);
      return verifyProject(sandboxId);
    });
    let validation = {
      ok: !initialInstallFeedback && initialVerification.ok,
      feedback: combineFeedback(
        initialInstallFeedback,
        initialVerification.feedback
      ),
    };

    if (!validation.ok) {
      const repairResult = await step.run("repair-project-json", async () => {
        try {
          const project = await requestGeneratedProject({
            model: requestedModel,
            prompt: JSON_REPAIR_PROMPT,
            userRequest: event.data.value,
            previousMessages,
            existingFiles: finalFiles,
            validationFeedback: validation.feedback,
          });
          return { kind: "ok" as const, project };
        } catch (error) {
          // Repair is a best-effort polish pass. If the LLM is rate-limited
          // here, we still have a usable initial build — don't fail the run.
          if (error instanceof RateLimitError) {
            console.warn(
              `[code-agent] repair pass skipped: ${error.message}`
            );
            return {
              kind: "skipped" as const,
              reason: error.message,
            };
          }
          throw error;
        }
      });

      if (repairResult.kind === "ok") {
        const repairedProject = repairResult.project;

        // Same scanner-driven install set as the initial pass: union of
        // declared packages with packages inferred from actual import
        // statements in the repaired source.
        const repairPackagesToInstall = (() => {
          const repairedFileMap: FileCollection = Object.fromEntries(
            repairedProject.files.map((f) => [f.path, f.content])
          );
          const inferred = extractImportedPackages({
            ...finalFiles,
            ...repairedFileMap,
          });
          return [...repairedProject.packages, ...inferred];
        })();

        const repairInstallResult = await step.run(
          "install-repair-packages",
          async () => {
            return installPackages(sandboxId, repairPackagesToInstall);
          }
        );
        const repairInstallFeedback = buildInstallFailureFeedback(
          "Repair",
          repairInstallResult
        );

        finalFiles = await step.run("apply-repaired-files", async () => {
          return applyGeneratedProject(sandboxId, finalFiles, repairedProject);
        });

        const repairVerification = await step.run(
          "reverify-project",
          async () => {
            await ensureNextDevServer(sandboxId);
            return verifyProject(sandboxId);
          }
        );
        validation = {
          ok: !repairInstallFeedback && repairVerification.ok,
          feedback: combineFeedback(
            repairInstallFeedback,
            repairVerification.feedback
          ),
        };

        generatedProject = mergeGeneratedProject(
          generatedProject,
          repairedProject
        );
      } else {
        // Repair was skipped due to a rate limit. Keep the initial validation
        // feedback so the user knows what wasn't fixed, and append a notice.
        validation = {
          ok: validation.ok,
          feedback: combineFeedback(
            validation.feedback,
            `Note: an automatic repair pass was skipped because the AI provider was rate-limited (${repairResult.reason}). The initial build is shown as-is; resend a follow-up prompt in ~60 seconds to refine it.`
          ),
        };
      }
    }

    const finalInstalledPackages = sanitizePackageNames([
      ...existingMetadata.installedPackages,
      ...generatedProject.packages,
    ]);

    finalFiles = withProjectMetadata(finalFiles, finalInstalledPackages);

    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      // Final safety net: hand back a URL only after dev server is confirmed
      // listening, otherwise the user clicks the link and gets "Connection
      // refused on port 3000" from E2B's edge.
      await ensureNextDevServer(sandboxId);
      const sandbox = await getSandbox(sandboxId);
      const host = sandbox.getHost(3000);
      return `https://${host}`;
    });

    const visibleFinalFiles = getVisibleProjectFiles(finalFiles);
    const changedSomething =
      generatedProject.files.length > 0 ||
      generatedProject.deletedFiles.length > 0 ||
      generatedProject.packages.length > 0;
    const hasVisibleFiles =
      Object.keys(visibleFinalFiles).length > 0 ||
      Object.keys(trackedFiles).length > 0;
    const isError = !changedSomething && !hasVisibleFiles;

    const assistantContent = validation.ok
      ? generatedProject.response
      : `${generatedProject.response} The latest files are attached, but one more cleanup pass may still help.`;

    await step.run("save-result", async () => {
      if (isError) {
        return prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: "Something went wrong. Please try again.",
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      }

      return prisma.message.create({
        data: {
          projectId: event.data.projectId,
          content: assistantContent,
          role: "ASSISTANT",
          type: "RESULT",
          fragment: {
            create: {
              sandboxUrl,
              title: generatedProject.title,
              files: finalFiles,
            },
          },
        },
      });
    });

    return {
      url: sandboxUrl,
      title: generatedProject.title,
      files: visibleFinalFiles,
      summary: generatedProject.summary,
      validation,
    };
  }
);
