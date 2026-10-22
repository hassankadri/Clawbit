import { API_URL, authenticatedFetch, getAuthState } from "@/lib/auth";
import { browserOwnership } from "@/lib/browser-owner";
import type { Message, ChatSnapshot } from "@/hooks/useChat";

export interface ConversationRecord {
  id: string;
  thread_id: string;
  workspace_id: string;
  title: string;
  preview?: string;
  pinned: boolean;
  model: string;
  mode: "normal" | "research";
  createdAt: number;
  updatedAt: number;
  version: number;
  revision_id: string | null;
  messages?: Message[];
  running?: boolean;
}

export class HistoryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch(`${API_URL}/history${path}`, {
    method, signal,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new HistoryError("The history server returned an unreadable response. Your saved history is unchanged.", response.status);
  }
  if (!response.ok) {
    throw new HistoryError(
      typeof result?.detail === "string" ? result.detail : "Could not update saved history.", response.status,
    );
  }
  return result as T;
}

export function listHistory(signal?: AbortSignal) {
  return request<{ conversations: ConversationRecord[]; deleted_threads: string[] }>("", "GET", undefined, signal);
}

export function loadHistory(threadId: string, signal?: AbortSignal) {
  return request<ConversationRecord>(`/${encodeURIComponent(threadId)}`, "GET", undefined, signal);
}

export function createHistory(body: Pick<ConversationRecord, "id" | "thread_id" | "workspace_id" | "model" | "mode" | "title">, signal?: AbortSignal) {
  return request<ConversationRecord>("", "POST", body, signal);
}

export function updateHistory(record: ConversationRecord, update: { title?: string; pinned?: boolean; workspace_id?: string }) {
  return request<ConversationRecord>(`/${encodeURIComponent(record.thread_id)}`, "PATCH", { version: record.version, ...update });
}

export function removeHistoryMessage(threadId: string, messageId: string, version: number) {
  return request<ConversationRecord>(`/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}?version=${version}`, "DELETE");
}

export interface RevisionRecord {
  id: string;
  state: string;
  operation: string;
  createdAt: number;
}

export function listRevisions(threadId: string) {
  return request<{ revisions: RevisionRecord[] }>(`/${encodeURIComponent(threadId)}/revisions`);
}

export function loadRevision(threadId: string, revisionId: string) {
  return request<{ id: string; state: string; messages: Message[] }>(`/${encodeURIComponent(threadId)}/revisions/${encodeURIComponent(revisionId)}`);
}

export function deleteHistory(record: ConversationRecord) {
  return request<{ deleted: boolean }>(`/${encodeURIComponent(record.thread_id)}?version=${record.version}`, "DELETE");
}

export function historySnapshot(record: ConversationRecord): ChatSnapshot {
  return {
    messages: record.messages ?? [], threadId: record.thread_id, model: record.model,
    historyVersion: record.version, workspaceId: record.workspace_id,
    conversationId: record.id, serverPersisted: true,
    mode: record.mode,
  };
}

export interface LegacyConversation {
  id: string;
  title: string;
  pinned?: boolean;
  updatedAt: number;
  snapshot: ChatSnapshot;
  workspaceId?: string;
}

/** Validate local records before hydration; never repair or overwrite their source. */
export function isLegacyConversation(value: unknown): value is LegacyConversation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LegacyConversation>;
  const snapshot = item.snapshot;
  return typeof item.id === "string" && typeof item.title === "string"
    && typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
    && !!snapshot && typeof snapshot.threadId === "string"
    && typeof snapshot.model === "string" && Array.isArray(snapshot.messages)
    && snapshot.messages.every((message) => message && typeof message.id === "string"
      && (message.role === "user" || message.role === "assistant")
      && typeof message.content === "string");
}

export function parseLegacyArray<T>(raw: string | null, valid: (value: unknown) => value is T): T[] {
  if (raw === null) return [];
  const records: unknown = JSON.parse(raw);
  if (!Array.isArray(records) || !records.every(valid)) {
    throw new Error("Browser history contains invalid records. The original data is retained.");
  }
  return records;
}

export function selectSavedConversation<T extends { id: string; snapshot: ChatSnapshot }>(
  conversations: T[], activeId: string, workspaceId: string | null,
): T | undefined {
  const candidates = workspaceId
    ? conversations.filter((item) => item.snapshot.workspaceId === workspaceId)
    : conversations;
  return candidates.find((item) => item.id === activeId)
    ?? (workspaceId ? candidates[0] : undefined);
}

/** Import only after the caller displays explicit confirmation to the owner. */
export async function importLegacyConversation(item: LegacyConversation, confirmedPrincipal: string) {
  const principal = getAuthState().user?.principal_id;
  if (!principal || principal !== confirmedPrincipal || browserOwnership(principal) !== "owned") {
    throw new Error("This browser history does not belong to the signed-in account.");
  }
  const saved = await createHistory({
    id: item.id, thread_id: item.snapshot.threadId,
    workspace_id: item.workspaceId ?? item.snapshot.workspaceId ?? item.snapshot.threadId,
    title: item.title, model: item.snapshot.model, mode: item.snapshot.mode ?? "normal",
  });
  const messages = item.snapshot.messages.map((message) => ({
    id: message.id, role: message.role, content: message.content,
    status: message.status === "streaming" ? "cancelled" : message.status ?? "complete",
    createdAt: message.createdAt ?? item.updatedAt,
    attachmentIds: message.attachmentIds ?? [], sources: message.sources ?? [],
    error: message.error ?? null, errorStatus: message.errorStatus ?? null,
  }));
  const result = await request<ConversationRecord>(`/${encodeURIComponent(saved.thread_id)}/import`, "POST", {
    version: saved.version, import_id: `browser:${item.id}`, confirmed_principal: principal,
    messages, updatedAt: item.updatedAt,
  });
  return item.pinned && !result.pinned ? updateHistory(result, { pinned: true }) : result;
}
