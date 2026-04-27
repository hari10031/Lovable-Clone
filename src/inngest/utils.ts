import { SANDBOX_TIMEOUT_IN_MS } from "@/constants";
import { Sandbox } from "@e2b/code-interpreter";

import { FileCollection } from "@/types";

export async function getSandbox(sandboxId: string) {
  const sandbox = await Sandbox.connect(sandboxId);
  await sandbox.setTimeout(SANDBOX_TIMEOUT_IN_MS);

  return sandbox;
}

export function normalizeStoredFiles(value: unknown): FileCollection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const files: FileCollection = {};

  for (const [path, content] of Object.entries(value)) {
    if (typeof content === "string") {
      files[path] = content;
    }
  }

  return files;
}

export function buildConversationTranscript(
  messages: Array<{ role: "user" | "assistant"; content: string }>
) {
  if (!messages.length) {
    return "No previous conversation.";
  }

  return messages
    .map(
      (message, index) =>
        `${index + 1}. ${message.role.toUpperCase()}: ${message.content}`
    )
    .join("\n");
}

export function serializeFilesForPrompt(files: FileCollection) {
  const entries = Object.entries(files);

  if (!entries.length) {
    return "No existing project files. Build the project from scratch.";
  }

  return entries
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(
      ([path, content]) =>
        `FILE: ${path}\n<<<CONTENT\n${content}\nCONTENT;`
    )
    .join("\n\n");
}

export function extractJsonObject(text: string) {
  const trimmed = text.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;

  const start = withoutFence.indexOf("{");

  if (start === -1) {
    return null;
  }

  // Scan forward, tracking string state and brace depth so a `}` inside a
  // string literal (or a stray brace from a truncated response) doesn't
  // produce malformed JSON.
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < withoutFence.length; i++) {
    const ch = withoutFence[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return withoutFence.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function normalizeRelativePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function isSafeRelativePath(path: string) {
  if (!path || path.startsWith("/") || path.includes("..")) {
    return false;
  }

  if (/^[A-Za-z]:/.test(path)) {
    return false;
  }

  return true;
}

// Walks every generated .ts/.tsx/.js/.jsx/.mjs file and extracts bare-module
// imports (i.e. `import X from "pkg"`, `import("pkg")`, `require("pkg")`).
// Skips relative ("./", "../"), absolute ("/"), alias ("@/"), and node-builtin
// ("node:") specifiers. The model frequently forgets to list dependencies in
// its `packages` array, so we infer them from the actual import graph and
// merge them into the install set. Without this, builds blow up at runtime
// with "Cannot resolve 'tailwind-merge'", "Cannot resolve 'framer-motion'",
// etc., even though the imports are visible in the generated source.
export function extractImportedPackages(files: FileCollection): string[] {
  const codeExt = /\.(?:tsx?|jsx?|mjs|cjs)$/i;
  // Matches:
  //   import X from "pkg"
  //   import { a, b } from "pkg"
  //   import "pkg"
  //   import("pkg")
  //   require("pkg")
  //   export { x } from "pkg"
  //   export * from "pkg"
  const importRegex =
    /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?|export\s+(?:[\w*{}\s,]+\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

  const found = new Set<string>();

  for (const [path, content] of Object.entries(files)) {
    if (!codeExt.test(path) || typeof content !== "string") continue;

    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const spec = match[1];
      if (!spec) continue;

      // Skip relative, absolute, alias, and node-builtin specifiers.
      if (
        spec.startsWith(".") ||
        spec.startsWith("/") ||
        spec.startsWith("@/") ||
        spec.startsWith("~/") ||
        spec.startsWith("node:")
      ) {
        continue;
      }

      // Reduce a deep import to its package root:
      //   "lodash/debounce"           -> "lodash"
      //   "@radix-ui/react-dialog"    -> "@radix-ui/react-dialog"
      //   "@scope/pkg/sub/path"       -> "@scope/pkg"
      //   "next/font/google"          -> "next" (filtered later as built-in)
      let pkg: string;
      if (spec.startsWith("@")) {
        const parts = spec.split("/");
        if (parts.length < 2) continue;
        pkg = `${parts[0]}/${parts[1]}`;
      } else {
        pkg = spec.split("/")[0];
      }

      if (pkg) found.add(pkg);
    }
  }

  return Array.from(found);
}

export function sanitizePackageNames(packages: string[]) {
  // Only packages that are GUARANTEED to be in the sandbox template at boot,
  // so we never need to npm-install them. Everything else flows through to
  // npm install — even if it's already there, npm is idempotent and fast.
  const builtInPackages = new Set([
    "next",
    "react",
    "react-dom",
    "typescript",
    "tailwindcss",
    "tw-animate-css",
  ]);

  // Subpath imports of built-in packages (e.g. "next/font/google",
  // "next/image", "react/jsx-runtime") are NOT separate npm packages.
  // The model occasionally lists them — silently drop them here.
  const builtInSubpathPrefixes = ["next/", "react/", "react-dom/"];

  // Hallucinated org-scopes the model sometimes invents that aren't real npm
  // packages. We keep this list deliberately tiny — `@radix-ui/*` and
  // `@shadcn/ui` ARE real and shadcn components depend on them, so DO install.
  const fakePrefixes = ["@types/next-themes-mock", "@internal/"];

  return Array.from(
    new Set(
      packages
        .map((pkg) => pkg.trim())
        .filter(Boolean)
        .filter((pkg) => /^[A-Za-z0-9@._/-]+$/.test(pkg))
        .filter((pkg) => !builtInPackages.has(pkg))
        .filter((pkg) => !builtInSubpathPrefixes.some((p) => pkg.startsWith(p)))
        .filter((pkg) => !fakePrefixes.some((p) => pkg.startsWith(p)))
    )
  );
}
