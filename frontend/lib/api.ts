import {
  API_URL,
  authenticatedFetch,
  authenticatedHeaders,
  handleAuthStatus,
  registerUpload,
} from "@/lib/auth";
import {
  getPersonalizationRequestPayload,
  type PersonalizationRequestPayload,
} from "@/lib/personalization";
import { getModelConsent, type ModelOption } from "@/lib/models";

/* ====================================================== */
/* CHAT MODE                                              */
/* ====================================================== */

export type ChatMode =
  | "normal"
  | "research";

const CHAT_MODE_STORAGE_KEY =
  "clawbit.chat.mode.v1";

let activeChatMode: ChatMode =
  "normal";

function isChatMode(
  value: unknown,
): value is ChatMode {
  return (
    value === "normal" ||
    value === "research"
  );
}

export function setActiveChatMode(
  mode: ChatMode,
) {
  activeChatMode =
    mode;

  if (
    typeof window ===
    "undefined"
  ) {
    return;
  }

  try {
    window.localStorage.setItem(
      CHAT_MODE_STORAGE_KEY,
      mode,
    );
  } catch {
    // localStorage unavailable.
  }
}

export function getActiveChatMode():
  ChatMode {
  if (
    typeof window ===
    "undefined"
  ) {
    return activeChatMode;
  }

  try {
    const stored =
      window.localStorage.getItem(
        CHAT_MODE_STORAGE_KEY,
      );

    if (
      isChatMode(
        stored,
      )
    ) {
      activeChatMode =
        stored;
    }
  } catch {
    // localStorage unavailable.
  }

  return activeChatMode;
}

/* ====================================================== */
/* CHAT TYPES                                             */
/* ====================================================== */

export type ChatInspectorSource = import("@/lib/knowledge").SourceReference;

export interface ChatInspector {
  research?: import("@/lib/knowledge").ResearchReport;
  rag_used: boolean;

  user_query?:
    string;

  tool_query?:
    string;

  rewritten_query?:
    string;

  search_limit?:
    number;

  vector_candidates?:
    number;

  bm25_candidates?:
    number;

  hybrid_candidates?:
    number;

  retrieval_error?:
    boolean;

  after_deduplication?:
    number;

  reranking_completed?:
    boolean;

  reranked_candidates?:
    number;

  selected_chunks?:
    number;

  fallback_used?:
    boolean;

  cache_hit?:
    boolean;

  sources?:
    ChatInspectorSource[];

  [key: string]:
    unknown;
}

export interface ChatRequest {
  request_id?: string;
  user_message_id?: string;
  assistant_message_id?: string;
  expected_version?: number;
  operation?: "send" | "edit" | "retry" | "regenerate";
  target_message_id?: string;
  provider_consent?: string;
  message:
    string;

  model:
    string;

  thread_id?:
    string;

  workspace_id?:
    string;

  attachment_ids?:
    string[];

  mode?:
    ChatMode;

  /*
   * Personalization fields.
   *
   * These are optional here because resolveChatRequest()
   * automatically fills them from the user's saved
   * Personalization preferences.
   */
  assistant_name?:
    PersonalizationRequestPayload["assistant_name"];

  response_tone?:
    PersonalizationRequestPayload["response_tone"];

  response_length?:
    PersonalizationRequestPayload["response_length"];

  custom_instructions?:
    PersonalizationRequestPayload["custom_instructions"];
}

export interface ChatResponse {
  response:
    string;

  thread_id:
    string;

  inspector?:
    | ChatInspector
    | null;
}

/* ====================================================== */
/* PERSONALIZED CHAT REQUEST                              */
/* ====================================================== */

function resolveChatRequest(
  body: ChatRequest,
): ChatRequest {
  const personalization =
    getPersonalizationRequestPayload();

  return {
    /*
     * Add the saved personalization first.
     *
     * If a caller deliberately sends one of these fields,
     * that explicit value wins because body is spread after it.
     */
    ...personalization,

    ...body,
    provider_consent: body.provider_consent ?? getModelConsent(body.model),

    /*
     * The UI's current Normal / Research setting is also
     * attached automatically unless a caller explicitly
     * supplied a mode.
     */
    mode:
      body.mode ??
      getActiveChatMode(),
  };
}

/* ====================================================== */
/* FILE UPLOAD                                            */
/* ====================================================== */

export interface AttachmentUploadResponse {
  attachment_id:
    string;

  name:
    string;

  mime_type:
    string;

  kind:
    | "document"
    | "image";

  size:
    number;

  preview?:
    string;
}

export interface UploadProgressHandlers {
  onProgress?: (
    progress: number,
  ) => void;

  onError?: (
    error: string,
  ) => void;
}

/* ====================================================== */
/* STREAMING TYPES                                        */
/* ====================================================== */

export interface StreamStartEvent {
  thread_id:
    string;
}

export interface StreamDoneEvent {
  thread_id:
    string;

  inspector?:
    | ChatInspector
    | null;
}

export interface StreamErrorEvent {
  status_code?: number;
  retry_after?: number | null;
  message:
    string;

  thread_id?:
    string;
}

export interface ChatStreamHandlers {
  onSources?: (sources: ChatInspectorSource[]) => void;
  onStart?: (
    event: StreamStartEvent,
  ) => void;

  onToken?: (
    text: string,
  ) => void;

  onDone?: (
    event: StreamDoneEvent,
  ) => void;

  onError?: (
    event: StreamErrorEvent,
  ) => void;
}

/* ====================================================== */
/* MCP TYPES                                              */
/* ====================================================== */

export interface MCPTool {
  name:
    string;

  description:
    string;
}

export interface MCPServerStatus {
  id:
    string;

  name:
    string;

  transport:
    string;

  status:
    string;

  tools:
    MCPTool[];

  error?:
    string;
}

export interface MCPStatusResponse {
  connected:
    boolean;

  server_count:
    number;

  connected_server_count:
    number;

  tool_count:
    number;

  servers:
    MCPServerStatus[];
}

export interface MCPConnectorCatalogItem {
  id:
    string;

  name:
    string;

  description:
    string;

  category:
    string;

  configured:
    boolean;

  auth?:
    | "token"
    | "oauth"
    | string;

  credential_label?:
    string;

  available?:
    boolean;
}

export interface MCPConnectorCatalogResponse {
  connectors:
    MCPConnectorCatalogItem[];
}

export interface MCPOAuthStartResponse {
  authorization_url:
    string;

  provider:
    string;
}

export interface MCPActionResponse {
  success:
    boolean;

  disconnected?:
    boolean;

  error?:
    string;

  server?:
    MCPServerStatus;

  [key: string]:
    unknown;
}

/* ====================================================== */
/* ERROR HELPERS                                          */
/* ====================================================== */

function withRetryHint(message: string, retryAfter: unknown): string {
  const seconds = typeof retryAfter === "string" ? Number(retryAfter) : retryAfter;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0
      || /try again in \d+ seconds/i.test(message)) {
    return message;
  }
  return `${message} Try again in ${Math.ceil(seconds)} seconds.`;
}

function getErrorMessage(
  responseText: string,
  fallback: string,
  retryAfter?: string | null,
): string {
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    const message = [parsed.detail, parsed.error, parsed.message].find(
      (value): value is string => typeof value === "string" && Boolean(value.trim()),
    );
    return withRetryHint(message ?? fallback, parsed.retry_after ?? retryAfter);
  } catch {
    return withRetryHint(fallback, retryAfter);
  }
}

function backendUnavailableMessage() {
  return (
    `Could not reach the Clawbit backend at ${API_URL}. ` +
    "Make sure the Python server is running."
  );
}

/* ====================================================== */
/* GENERIC JSON REQUEST                                   */
/* ====================================================== */

async function requestJSON<T>(
  path: string,
  options: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  try {
    const response =
      await authenticatedFetch(
        `${API_URL}${path}`,
        {
          ...options,

          headers: {
            ...(options.body
              ? {
                  "Content-Type":
                    "application/json",
                }
              : {}),

            ...options.headers,
          },

          signal:
            signal ??
            options.signal,
        },
      );

    const responseText =
      await response.text();

    if (
      !response.ok
    ) {
      throw new Error(
        getErrorMessage(
          responseText,
          `Request failed with status ${response.status}.`,
          response.headers.get("Retry-After"),
        ),
      );
    }

    if (
      !responseText.trim()
    ) {
      return {} as T;
    }

    try {
      return JSON.parse(
        responseText,
      ) as T;
    } catch {
      throw new Error(
        "The backend returned an invalid response.",
      );
    }
  } catch (
    error
  ) {
    if (
      error instanceof
        DOMException &&
      error.name ===
        "AbortError"
    ) {
      throw error;
    }

    if (
      error instanceof
        Error &&
      error.name ===
        "AbortError"
    ) {
      throw error;
    }

    if (
      error instanceof
      TypeError
    ) {
      throw new Error(
        backendUnavailableMessage(),
      );
    }

    throw error;
  }
}

/* ====================================================== */
/* ATTACHMENT UPLOAD                                      */
/* ====================================================== */

export function uploadAttachment(
  threadId: string,
  file: File,
  handlers:
    UploadProgressHandlers = {},
) {
  const xhr =
    new XMLHttpRequest();

  const promise =
    new Promise<AttachmentUploadResponse>(
      (
        resolve,
        reject,
      ) => {
        xhr.open(
          "POST",
          `${API_URL}/attachments/upload`,
        );

        xhr.withCredentials = true;
        let requestCsrfToken = "";
        try {
          const headers = authenticatedHeaders();
          requestCsrfToken = headers["X-CSRF-Token"];
          for (const [name, value] of Object.entries(headers)) {
            xhr.setRequestHeader(name, value);
          }
        } catch (error) {
          reject(error);
          return;
        }
        const unregister = registerUpload(() => xhr.abort());
        xhr.onloadend = unregister;

        xhr.upload.onprogress =
          (
            event,
          ) => {
            if (
              !event.lengthComputable
            ) {
              return;
            }

            const progress =
              Math.round(
                (
                  event.loaded /
                  event.total
                ) * 100,
              );

            handlers.onProgress?.(
              progress,
            );
          };

        xhr.onerror =
          () => {
            const message =
              backendUnavailableMessage();

            handlers.onError?.(
              message,
            );

            reject(
              new Error(
                message,
              ),
            );
          };

        xhr.onabort =
          () => {
            const message =
              "Upload canceled.";

            handlers.onError?.(
              message,
            );

            reject(
              new Error(
                message,
              ),
            );
          };

        xhr.onload =
          () => {
            handleAuthStatus(xhr.status, requestCsrfToken);
            if (
              xhr.status <
                200 ||
              xhr.status >=
                300
            ) {
              const message =
                getErrorMessage(
                  xhr.responseText,

                  "Upload failed. Please try again.",
                  xhr.getResponseHeader("Retry-After"),
                );

              handlers.onError?.(
                message,
              );

              reject(
                new Error(
                  message,
                ),
              );

              return;
            }

            try {
              resolve(
                JSON.parse(
                  xhr.responseText,
                ) as AttachmentUploadResponse,
              );
            } catch {
              const message =
                "Upload failed because the backend returned an invalid response.";

              handlers.onError?.(
                message,
              );

              reject(
                new Error(
                  message,
                ),
              );
            }
          };

        const formData =
          new FormData();

        formData.append(
          "thread_id",
          threadId,
        );

        formData.append(
          "file",
          file,
        );

        xhr.send(
          formData,
        );
      },
    );

  return {
    promise,

    abort: () =>
      xhr.abort(),
  };
}

/* ====================================================== */
/* NORMAL CHAT                                            */
/* ====================================================== */

export async function chat(
  body: ChatRequest,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  try {
    const response =
      await authenticatedFetch(
        `${API_URL}/chat`,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(
              resolveChatRequest(
                body,
              ),
            ),

          signal,
        },
      );

    if (
      !response.ok
    ) {
      const responseText =
        await response.text();

      throw new Error(
        getErrorMessage(
          responseText,

          "Failed to send message.",
          response.headers.get("Retry-After"),
        ),
      );
    }

    return response.json();
  } catch (
    error
  ) {
    if (
      error instanceof
        DOMException &&
      error.name ===
        "AbortError"
    ) {
      throw error;
    }

    if (
      error instanceof
        Error &&
      error.name ===
        "AbortError"
    ) {
      throw error;
    }

    if (
      error instanceof
      TypeError
    ) {
      throw new Error(
        backendUnavailableMessage(),
      );
    }

    throw error;
  }
}

/* ====================================================== */
/* STREAMING CHAT                                         */
/* ====================================================== */

export class ChatStreamError extends Error {
  constructor(
    message: string,
    public readonly status_code?: number,
    public readonly retry_after?: number | null,
  ) {
    super(message);
    this.name = "ChatStreamError";
  }
}

export async function streamChat(
  body: ChatRequest,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const requestCsrfToken = authenticatedHeaders()["X-CSRF-Token"];
  let response: Response;
  try {
    response = await authenticatedFetch(`${API_URL}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(resolveChatRequest(body)),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    throw new ChatStreamError(backendUnavailableMessage());
  }
  if (!response.ok) {
    const retry = response.headers.get("Retry-After");
    throw new ChatStreamError(
      getErrorMessage(await response.text(), "Failed to start streaming response.", retry),
      response.status,
      retry && Number.isFinite(Number(retry)) ? Number(retry) : undefined,
    );
  }
  if (!response.body) {
    throw new ChatStreamError("Streaming response body is unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maximumFrameLength = 1024 * 1024;
  let buffer = "";
  let terminal = false;
  let threadId: string | undefined;
  const malformed = () => new ChatStreamError("The response stream was malformed. Please retry.");

  function handleEventBlock(block: string) {
    if (block.length > maximumFrameLength) throw malformed();
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // Comments, keepalives and future event types are not assistant text.
    if (!["start", "token", "done", "error", "sources"].includes(eventName)) return;
    if (!dataLines.length) throw malformed();
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(dataLines.join("\n"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw malformed();
      data = parsed as Record<string, unknown>;
    } catch {
      throw malformed();
    }
    if (eventName === "start" || eventName === "done") {
      if (typeof data.thread_id !== "string" || !data.thread_id
          || (threadId !== undefined && data.thread_id !== threadId)
          || (body.thread_id && data.thread_id !== body.thread_id)) throw malformed();
      if (eventName === "start") {
        if (threadId !== undefined) throw malformed();
        threadId = data.thread_id;
        handlers.onStart?.(data as unknown as StreamStartEvent);
      } else {
        terminal = true;
        handlers.onDone?.(data as unknown as StreamDoneEvent);
      }
    } else if (eventName === "sources") {
      if (!Array.isArray(data.sources) || data.sources.length > 32 || data.sources.some((source) =>
        !source || typeof source !== "object" || typeof source.file !== "string"
        || typeof source.source_id !== "string" || !/^S[0-9a-f]{24}$/.test(source.source_id)
        || (source.page != null && (!Number.isInteger(source.page) || source.page < 1))
        || ["url", "thread_id", "attachment_id", "chunk_id"].some((key) =>
          source[key] !== undefined && typeof source[key] !== "string")
        || (source.kind !== "document" && source.kind !== "web"))) throw malformed();
      handlers.onSources?.(data.sources as ChatInspectorSource[]);
    } else if (eventName === "token") {
      if (typeof data.text !== "string") throw malformed();
      handlers.onToken?.(data.text);
    } else {
      if (typeof data.message !== "string" || !data.message.trim()) throw malformed();
      if (data.status_code !== undefined && (
        !Number.isInteger(data.status_code) || Number(data.status_code) < 400
        || Number(data.status_code) > 599
      )) throw malformed();
      if (data.retry_after !== undefined && data.retry_after !== null && (
        typeof data.retry_after !== "number" || !Number.isFinite(data.retry_after)
        || data.retry_after < 0
      )) throw malformed();
      terminal = true;
      const error = data as unknown as StreamErrorEvent;
      const message = withRetryHint(error.message, error.retry_after);
      if (error.status_code === 401) handleAuthStatus(401, requestCsrfToken);
      if (handlers.onError) handlers.onError({ ...error, message });
      else throw new ChatStreamError(message, error.status_code, error.retry_after);
    }
  }

  try {
    while (!terminal) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        signal?.throwIfAborted();
        handleEventBlock(block);
        if (terminal) return;
      }
      if (buffer.length > maximumFrameLength) throw malformed();
      if (done) {
        // A truncated frame is not completion, even when some answer text arrived.
        throw new ChatStreamError("The response stream ended unexpectedly. Please retry.");
      }
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")
        || error instanceof ChatStreamError) throw error;
    throw new ChatStreamError("The response stream was interrupted. Please retry.");
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A disconnected transport may already be closed.
    }
    reader.releaseLock();
  }
}

/* ====================================================== */
/* MCP CATALOG                                            */
/* ====================================================== */

export async function getMCPCatalog(
  signal?: AbortSignal,
): Promise<MCPConnectorCatalogResponse> {
  return requestJSON<MCPConnectorCatalogResponse>(
    "/mcp/catalog",
    {
      method:
        "GET",
    },
    signal,
  );
}

/* ====================================================== */
/* MCP STATUS                                             */
/* ====================================================== */

export async function getMCPStatus(
  signal?: AbortSignal,
): Promise<MCPStatusResponse> {
  return requestJSON<MCPStatusResponse>(
    "/mcp/status",
    {
      method:
        "GET",
    },
    signal,
  );
}

/* ====================================================== */
/* MCP REFRESH                                            */
/* ====================================================== */

export async function refreshMCPStatus(
  signal?: AbortSignal,
): Promise<MCPStatusResponse> {
  return requestJSON<MCPStatusResponse>(
    "/mcp/refresh",
    {
      method:
        "POST",
    },
    signal,
  );
}

/* ====================================================== */
/* GITHUB MCP                                             */
/* ====================================================== */

export async function connectGitHubMCP(
  token: string,
  signal?: AbortSignal,
): Promise<MCPActionResponse> {
  return requestJSON<MCPActionResponse>(
    "/mcp/connect/github",

    {
      method:
        "POST",

      body:
        JSON.stringify({
          token,
        }),
    },

    signal,
  );
}

export async function disconnectGitHubMCP(
  signal?: AbortSignal,
): Promise<MCPActionResponse> {
  return requestJSON<MCPActionResponse>(
    "/mcp/disconnect/github",

    {
      method:
        "POST",
    },

    signal,
  );
}

/* ====================================================== */
/* NOTION MCP                                             */
/* ====================================================== */

export async function connectNotionMCP(
  token: string,
  signal?: AbortSignal,
): Promise<MCPActionResponse> {
  return requestJSON<MCPActionResponse>(
    "/mcp/connect/notion",

    {
      method:
        "POST",

      body:
        JSON.stringify({
          token,
        }),
    },

    signal,
  );
}

export async function disconnectNotionMCP(
  signal?: AbortSignal,
): Promise<MCPActionResponse> {
  return requestJSON<MCPActionResponse>(
    "/mcp/disconnect/notion",

    {
      method:
        "POST",
    },

    signal,
  );
}

/* ====================================================== */
/* STRIPE MCP                                             */
/* ====================================================== */

export async function connectStripeMCP(
  secretKey: string,
  signal?: AbortSignal,
): Promise<MCPActionResponse> {
  return requestJSON<MCPActionResponse>(
    "/mcp/connect/stripe",

    {
      method:
        "POST",

      body:
        JSON.stringify({
          secret_key:
            secretKey,
        }),
    },

    signal,
  );
}

export async function disconnectStripeMCP(
  signal?: AbortSignal,
): Promise<MCPActionResponse> {
  return requestJSON<MCPActionResponse>(
    "/mcp/disconnect/stripe",

    {
      method:
        "POST",
    },

    signal,
  );
}

/* ====================================================== */
/* GOOGLE DRIVE MCP                                       */
/* ====================================================== */

export async function connectGoogleDriveMCP(
  signal?: AbortSignal,
): Promise<MCPOAuthStartResponse> {
  return requestJSON<MCPOAuthStartResponse>(
    "/mcp/connect/google-drive",

    {
      method:
        "POST",
    },

    signal,
  );
}

export async function disconnectGoogleDriveMCP(
  signal?: AbortSignal,
): Promise<MCPActionResponse> {
  return requestJSON<MCPActionResponse>(
    "/mcp/disconnect/google-drive",

    {
      method:
        "POST",
    },

    signal,
  );
}

/* ====================================================== */
/* SLACK MCP                                              */
/* ====================================================== */

export async function connectSlackMCP(
  signal?: AbortSignal,
): Promise<MCPOAuthStartResponse> {
  return requestJSON<MCPOAuthStartResponse>(
    "/mcp/connect/slack",

    {
      method:
        "POST",
    },

    signal,
  );
}

export async function disconnectSlackMCP(
  signal?: AbortSignal,
): Promise<MCPActionResponse> {
  return requestJSON<MCPActionResponse>(
    "/mcp/disconnect/slack",

    {
      method:
        "POST",
    },

    signal,
  );
}

export async function fetchModels(signal?: AbortSignal): Promise<ModelOption[]> {
  const response = await authenticatedFetch(`${API_URL}/models`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("Could not verify model availability.");
  const data = await response.json();
  if (!Array.isArray(data.models)) throw new Error("Invalid model catalog.");
  return data.models;
}
