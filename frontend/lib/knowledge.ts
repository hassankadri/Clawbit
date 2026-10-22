import { API_URL, authenticatedFetch } from "@/lib/auth";

export interface SourceReference {
  file: string;
  page?: number | null;
  source_id?: string;
  kind?: "document" | "web";
  thread_id?: string;
  attachment_id?: string;
  chunk_id?: string;
  url?: string;
}

export interface ResearchReport {
  retrieved_sources: number;
  cited_sources: number;
  limitations: string[];
}

export interface SavedMemory {
  id: number;
  content: string;
  version: number;
  scope: "workspace" | "user";
  workspace_id: string;
}

async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch(`${API_URL}${path}`, {
    method, signal,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result === null) {
    throw new Error(typeof result?.detail === "string" ? result.detail : "The saved resource is unavailable.");
  }
  return result as T;
}

export function sourcePath(source: SourceReference): string | null {
  if (source.kind !== "document" || !source.thread_id || !source.attachment_id) return null;
  return `/sources/${encodeURIComponent(source.thread_id)}/${encodeURIComponent(source.attachment_id)}`;
}

export function sourceUrl(source: SourceReference): string | null {
  if (source.kind !== "web" || !source.url || /[\s\\\x00-\x1f]/.test(source.url)) return null;
  try {
    const url = new URL(source.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const hostname = url.hostname.replace(/\.$/, "");
    if (!hostname.includes(".") || /(?:localhost|\.local|\.internal|\.lan|\.intranet)$/.test(hostname)) return null;
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(url.hostname)) return null;
    if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(url.hostname)) return null;
    if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(url.hostname)) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      const [first, second, third] = hostname.split(".").map(Number);
      if (first >= 224 || first === 0 || first === 192 && second === 0
          || first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)
          || first === 203 && second === 0 && third === 113) return null;
    }
    if (url.port && !["80", "443"].includes(url.port)) return null;
    if ([...url.searchParams.keys()].some((key) => /token|key|secret|signature|credential|authorization/i.test(key))) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function loadSource(source: SourceReference, signal?: AbortSignal) {
  const path = sourcePath(source);
  if (!path) return Promise.reject(new Error("This older source has no document reference."));
  return request<{ title: string; preview: string }>(path, "GET", undefined, signal);
}

export async function downloadSource(source: SourceReference) {
  const path = sourcePath(source);
  if (!path) throw new Error("Source unavailable.");
  const response = await authenticatedFetch(`${API_URL}${path}/content`);
  if (!response.ok) throw new Error("Source unavailable. It may have been removed.");
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = source.file.split(/[\\/]/).at(-1) || "document";
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function memoryQuery(scope: SavedMemory["scope"], workspaceId: string) {
  return new URLSearchParams({ scope, workspace_id: workspaceId }).toString();
}

export function listMemories(scope: SavedMemory["scope"], workspaceId: string, signal?: AbortSignal) {
  return request<{ memories: SavedMemory[] }>(`/memories?${memoryQuery(scope, workspaceId)}`, "GET", undefined, signal);
}

export function saveMemory(content: string, scope: SavedMemory["scope"], workspaceId: string, existing?: SavedMemory) {
  return request(existing ? `/memories/${existing.id}` : "/memories", existing ? "PATCH" : "POST", {
    content, scope, workspace_id: workspaceId, confirmed: true,
    ...(existing ? { version: existing.version } : {}),
  });
}

export function deleteMemory(memory: SavedMemory) {
  return request(`/memories/${memory.id}?${memoryQuery(memory.scope, memory.workspace_id)}&version=${memory.version}`, "DELETE");
}
