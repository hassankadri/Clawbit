export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  description: string;
  badge?: string;
  available: boolean;
}

export const MODELS: ModelOption[] = [
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    provider: "Google",
    description:
      "Current free-tier default with the fastest overall experience.",
    badge: "Default",
    available: true,
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    provider: "Google",
    description:
      "Higher-quality reasoning for deeper tasks and longer answers.",
    badge: "Pro",
    available: true,
  },
  {
  id: "openai/gpt-oss-20b",
  label: "GPT-OSS 20B",
  provider: "Groq",
  description:
    "Fast open model served through Groq for chat, coding, and tool use.",
  badge: "Fast",
  available: true,
},
  {
    id: "claude",
    label: "Claude",
    provider: "Anthropic",
    description: "Thoughtful long-form reasoning and writing.",
    badge: "Coming Soon",
    available: false,
  },
  {
    id: "gpt",
    label: "GPT",
    provider: "OpenAI",
    description: "General-purpose chat, coding, and multimodal work.",
    badge: "Coming Soon",
    available: false,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    provider: "DeepSeek",
    description: "Cost-efficient reasoning for code and analysis.",
    badge: "Coming Soon",
    available: false,
  },
  {
    id: "llama",
    label: "Llama",
    provider: "Meta",
    description: "Open model support for flexible local and cloud usage.",
    badge: "Coming Soon",
    available: false,
  },
];

export const DEFAULT_MODEL_ID =
  MODELS.find((model) => model.available)?.id ??
  "gemini-3.1-flash-lite";
