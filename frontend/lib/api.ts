import {
  getPersonalizationRequestPayload,
  type PersonalizationRequestPayload,
} from "@/lib/personalization";

/* ====================================================== */
/* API                                                    */
/* ====================================================== */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `http://${window.location.hostname || "127.0.0.1"}:8000`
    : "http://127.0.0.1:8000");

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

export interface ChatInspectorSource {
  file: string;
  page: number | null;
}

export interface ChatInspector {
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
  message:
    string;

  thread_id?:
    string;
}

export interface ChatStreamHandlers {
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

function getErrorMessage(
  responseText: string,
  fallback: string,
) {
  try {
    const parsed =
      JSON.parse(
        responseText,
      ) as {
        detail?:
          unknown;

        error?:
          unknown;

        message?:
          unknown;
      };

    if (
      typeof parsed.detail ===
        "string" &&
      parsed.detail.trim()
    ) {
      return parsed.detail;
    }

    if (
      typeof parsed.error ===
        "string" &&
      parsed.error.trim()
    ) {
      return parsed.error;
    }

    if (
      typeof parsed.message ===
        "string" &&
      parsed.message.trim()
    ) {
      return parsed.message;
    }
  } catch {
    // Response was not JSON.
  }

  return fallback;
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
      await fetch(
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
      await fetch(
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

export async function streamChat(
  body: ChatRequest,

  handlers:
    ChatStreamHandlers,

  signal?: AbortSignal,
): Promise<void> {
  let response:
    Response;

  try {
    response =
      await fetch(
        `${API_URL}/chat/stream`,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",

            Accept:
              "text/event-stream",
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

    throw new Error(
      backendUnavailableMessage(),
    );
  }

  if (
    !response.ok
  ) {
    const responseText =
      await response.text();

    throw new Error(
      getErrorMessage(
        responseText,

        "Failed to start streaming response.",
      ),
    );
  }

  if (
    !response.body
  ) {
    throw new Error(
      "Streaming response body is unavailable.",
    );
  }

  const reader =
    response.body.getReader();

  const decoder =
    new TextDecoder();

  let buffer =
    "";

  const handleEventBlock =
    (
      block:
        string,
    ) => {
      const lines =
        block.split(
          /\r?\n/,
        );

      let eventName =
        "message";

      const dataLines:
        string[] =
          [];

      for (
        const line
        of lines
      ) {
        if (
          line.startsWith(
            "event:",
          )
        ) {
          eventName =
            line
              .slice(
                "event:".length,
              )
              .trim();
        } else if (
          line.startsWith(
            "data:",
          )
        ) {
          dataLines.push(
            line
              .slice(
                "data:".length,
              )
              .trimStart(),
          );
        }
      }

      if (
        dataLines.length ===
        0
      ) {
        return;
      }

      const rawData =
        dataLines.join(
          "\n",
        );

      let data:
        unknown;

      try {
        data =
          JSON.parse(
            rawData,
          );
      } catch {
        return;
      }

      if (
        eventName ===
          "start" &&
        typeof data ===
          "object" &&
        data !== null
      ) {
        handlers.onStart?.(
          data as StreamStartEvent,
        );

        return;
      }

      if (
        eventName ===
          "token" &&
        typeof data ===
          "object" &&
        data !== null
      ) {
        const tokenData =
          data as {
            text?:
              unknown;
          };

        if (
          typeof tokenData.text ===
          "string"
        ) {
          handlers.onToken?.(
            tokenData.text,
          );
        }

        return;
      }

      if (
        eventName ===
          "done" &&
        typeof data ===
          "object" &&
        data !== null
      ) {
        handlers.onDone?.(
          data as StreamDoneEvent,
        );

        return;
      }

      if (
        eventName ===
          "error" &&
        typeof data ===
          "object" &&
        data !== null
      ) {
        handlers.onError?.(
          data as StreamErrorEvent,
        );
      }
    };

  while (
    true
  ) {
    const {
      value,
      done,
    } =
      await reader.read();

    if (
      done
    ) {
      break;
    }

    buffer +=
      decoder.decode(
        value,
        {
          stream:
            true,
        },
      );

    const eventBlocks =
      buffer.split(
        /\r?\n\r?\n/,
      );

    buffer =
      eventBlocks.pop() ??
      "";

    for (
      const eventBlock
      of eventBlocks
    ) {
      if (
        !eventBlock.trim()
      ) {
        continue;
      }

      handleEventBlock(
        eventBlock,
      );
    }
  }

  buffer +=
    decoder.decode();

  if (
    buffer.trim()
  ) {
    handleEventBlock(
      buffer,
    );
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
        "GET",
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
        "GET",
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