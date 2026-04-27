export const PROJECT_TEMPLATES = [
  {
    emoji: "🎬",
    title: "Build a Netflix clone",
    prompt:
      "Build a Netflix-style homepage with a hero banner (use a nice, dark-mode compatible gradient here), movie sections, responsive cards, and a modal for viewing details using mock data and local state. Use dark mode.",
  },
  {
    emoji: "📦",
    title: "Build an admin dashboard",
    prompt:
      "Create an admin dashboard with a sidebar, stat cards, a chart placeholder, and a basic table with filter and pagination using local state. Use clear visual grouping and balance in your design for a modern, professional look.",
  },
  {
    emoji: "📋",
    title: "Build a kanban board",
    prompt:
      "Build a kanban board with drag-and-drop using react-beautiful-dnd and support for adding and removing tasks with local state. Use consistent spacing, column widths, and hover effects for a polished UI.",
  },
  {
    emoji: "🗂️",
    title: "Build a file manager",
    prompt:
      "Build a file manager with folder list, file grid, and options to rename or delete items using mock data and local state. Focus on spacing, clear icons, and visual distinction between folders and files.",
  },
  {
    emoji: "📺",
    title: "Build a YouTube clone",
    prompt:
      "Build a YouTube-style homepage with mock video thumbnails, a category sidebar, and a modal preview with title and description using local state. Ensure clean alignment and a well-organized grid layout.",
  },
  {
    emoji: "🛍️",
    title: "Build a store page",
    prompt:
      "Build a store page with category filters, a product grid, and local cart logic to add and remove items. Focus on clear typography, spacing, and button states for a great e-commerce UI.",
  },
  {
    emoji: "🏡",
    title: "Build an Airbnb clone",
    prompt:
      "Build an Airbnb-style listings grid with mock data, filter sidebar, and a modal with property details using local state. Use card spacing, soft shadows, and clean layout for a welcoming design.",
  },
  {
    emoji: "🎵",
    title: "Build a Spotify clone",
    prompt:
      "Build a Spotify-style music player with a sidebar for playlists, a main area for song details, and playback controls. Use local state for managing playback and song selection. Prioritize layout balance and intuitive control placement for a smooth user experience. Use dark mode.",
  },
] as const;

// Cerebras Cloud model IDs verified against the user's /v1/models response.
// Cerebras is the preferred provider when CEREBRAS_API_KEY is set — they run
// inference at ~1500-2000 tok/s, ~20x faster than NVIDIA NIM serverless.
//
// Default: Qwen 3 235B (MoE, 22B active params) — best coding quality on
// Cerebras. Output should land in ~10-25s for typical prompts.
export const DEFAULT_CODE_MODEL = "qwen-3-235b-a22b-instruct-2507";

export const AVAILABLE_CODE_MODELS = [
  DEFAULT_CODE_MODEL,
  "gpt-oss-120b",
  "zai-glm-4.7",
  "llama3.1-8b",
] as const;

export const FREE_PLAN_POINTS = 1000;
export const PRO_PLAN_POINTS = 10000;
export const PRO_PLAN_PRICE_USD = 20;

export const MAX_SEGMENTS = 4;

export const SANDBOX_TIMEOUT_IN_MS = 30 * 60 * 1000; // 30 min

// Hard cap on total Clerk users that can sign up for this deployment.
// When the count is reached, the /sign-up page renders a "closed" notice
// instead of the SignUp form. Existing users can still sign in.
export const MAX_SIGNUP_ACCOUNTS = 15;
