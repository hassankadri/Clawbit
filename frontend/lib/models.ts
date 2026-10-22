export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  description: string;
  badge?: string;
  available: boolean;
  reason: string;
  consent_required: boolean;
  capabilities: { text: boolean; streaming: boolean; tools: boolean; vision: boolean; structured_output: boolean };
}

// Offline placeholders preserve saved selections; only /models can enable one.
const knownModels = [
  ["gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", "google"],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", "google"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash", "google"],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", "google"],
  ["openai/gpt-oss-20b", "GPT-OSS 20B", "groq"],
  ["openai/gpt-oss-120b", "GPT-OSS 120B", "groq"],
  ["qwen/qwen3.8-27b", "Qwen 3.8 27B", "groq"],
  ["nvidia/nemotron-3-ultra-550b-a55b:free", "Nemotron 3 Ultra", "openrouter"],
  ["nvidia/nemotron-3-super-120b-a12b:free", "Nemotron 3 Super", "openrouter"],
  ["nvidia/nemotron-3.5-lightning:free", "Nemotron 3.5 Lightning", "openrouter"],
  ["cohere/north-mini-code:free", "North Mini Code", "openrouter"],
  ["nvidia/nemotron-3.5-super-vl:free", "Nemotron 3.5 Super VL", "openrouter"],
  ["minimax/minimax-m3.1-flash:free", "MiniMax M3.1 Flash", "openrouter"],
];
export const DEFAULT_MODEL_ID = "gemini-3.1-flash-lite";
export const MODELS: ModelOption[] = knownModels.map(([id, label, provider]) => ({
  id, label, provider, description: "Checking server availability…", available: false,
  reason: "Server model verification is required.", consent_required: ![DEFAULT_MODEL_ID, "gemini-3.5-flash", "openai/gpt-oss-20b"].includes(id),
  capabilities: { text: true, streaming: false, tools: false, vision: false, structured_output: false },
}));
export const PROVIDER_LABELS: Record<string, string> = { google: "Google", groq: "Groq", openrouter: "OpenRouter · Free" };

export function mergeModelCatalog(entries: ModelOption[]): ModelOption[] {
  return MODELS.map((fallback) => {
    const entry = entries.find((item) => item.id === fallback.id && item.provider === fallback.provider);
    return entry && typeof entry.available === "boolean" && entry.capabilities
      ? { ...entry, consent_required: fallback.consent_required }
      : fallback;
  });
}

export function getModelConsent(model: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try { return window.sessionStorage.getItem(`clawbit.provider-consent.${model}`) === "yes" ? model : undefined; }
  catch { return undefined; }
}

export function confirmModelSelection(model: ModelOption): boolean {
  if (!model.available) return false;
  if (!model.consent_required || getModelConsent(model.id)) return true;
  if (!window.confirm(`Use ${model.label} via ${PROVIDER_LABELS[model.provider]}? This sends this conversation's history, uploads, memories and tool results to that provider. Free services may retain or use content for training. Do not send credentials or confidential content. Allow for this browser session?`)) return false;
  try { window.sessionStorage.setItem(`clawbit.provider-consent.${model.id}`, "yes"); }
  catch { return false; }
  return true;
}

export function imageSelectionError(model: ModelOption, file: Pick<File, "type" | "name">): string | null {
  const image = file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name);
  return image && (!model.available || !model.capabilities.vision)
    ? "Choose an available vision-capable model before attaching an image."
    : null;
}
