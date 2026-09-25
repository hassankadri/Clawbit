const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `http://${window.location.hostname || "127.0.0.1"}:8000`
    : "http://127.0.0.1:8000");

export type ChatMode =
  | "normal"
  | "research";

/*
  Current mode selected in the UI.

  This lets the existing chat hook keep working
  without forcing us to rewrite page.tsx right now.
*/
let activeChatMode: ChatMode =
  "normal";

export function setActiveChatMode(
  mode: ChatMode,
) {
  activeChatMode = mode;
}

export function getActiveChatMode():
  ChatMode {
  return activeChatMode;
}

export interface ChatInspectorSource {
  file: string;
  page: number | null;
}

export interface ChatInspector {
  rag_used: boolean;

  user_query?: string;
  tool_query?: string;
  rewritten_query?: string;

  search_limit?: number;

  vector_candidates?: number;
  bm25_candidates?: number;
  hybrid_candidates?: number;

  retrieval_error?: boolean;

  after_deduplication?: number;

  reranking_completed?: boolean;

  reranked_candidates?: number;

  selected_chunks?: number;

  fallback_used?: boolean;

  cache_hit?: boolean;

  sources?: ChatInspectorSource[];

  [key: string]: unknown;
}

export interface ChatRequest {
  message: string;

  model: string;

  thread_id?: string;

  workspace_id?: string;

  attachment_ids?: string[];

  mode?: ChatMode;
}

export interface ChatResponse {
  response: string;

  thread_id: string;

  inspector?: ChatInspector | null;
}

export interface AttachmentUploadResponse {
  attachment_id: string;

  name: string;

  mime_type: string;

  kind:
    | "document"
    | "image";

  size: number;

  preview?: string;
}

export interface UploadProgressHandlers {
  onProgress?: (
    progress: number,
  ) => void;

  onError?: (
    error: string,
  ) => void;
}

export interface StreamStartEvent {
  thread_id: string;
}

export interface StreamDoneEvent {
  thread_id: string;

  inspector?:
    | ChatInspector
    | null;
}

export interface StreamErrorEvent {
  message: string;

  thread_id?: string;
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

function getErrorMessage(
  responseText: string,
  fallback: string,
) {
  try {
    const parsed =
      JSON.parse(
        responseText,
      ) as {
        detail?: unknown;
      };

    if (
      typeof parsed.detail ===
        "string" &&
      parsed.detail.trim()
    ) {
      return parsed.detail;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function resolveChatRequest(
  body: ChatRequest,
): ChatRequest {
  return {
    ...body,

    mode:
      body.mode ??
      activeChatMode,
  };
}

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
          (event) => {
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

        xhr.onerror = () => {
          const message =
            `Upload failed. Could not reach the backend at ${API_URL}. ` +
            "Make sure the Python server is running.";

          handlers.onError?.(
            message,
          );

          reject(
            new Error(message),
          );
        };

        xhr.onabort = () => {
          const message =
            "Upload canceled.";

          handlers.onError?.(
            message,
          );

          reject(
            new Error(message),
          );
        };

        xhr.onload = () => {
          if (
            xhr.status < 200 ||
            xhr.status >= 300
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
              "Upload failed. Please try again.";

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

export async function chat(
  body: ChatRequest,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  const res =
    await fetch(
      `${API_URL}/chat`,
      {
        method: "POST",

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

  if (!res.ok) {
    const responseText =
      await res.text();

    throw new Error(
      getErrorMessage(
        responseText,
        "Failed to send message.",
      ),
    );
  }

  return res.json();
}

export async function streamChat(
  body: ChatRequest,
  handlers:
    ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res =
    await fetch(
      `${API_URL}/chat/stream`,
      {
        method: "POST",

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

  if (!res.ok) {
    const responseText =
      await res.text();

    throw new Error(
      getErrorMessage(
        responseText,
        "Failed to start streaming response.",
      ),
    );
  }

  if (!res.body) {
    throw new Error(
      "Streaming response body is unavailable.",
    );
  }

  const reader =
    res.body.getReader();

  const decoder =
    new TextDecoder();

  let buffer = "";

  const handleEventBlock = (
    block: string,
  ) => {
    const lines =
      block.split(/\r?\n/);

    let eventName =
      "message";

    const dataLines:
      string[] = [];

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
      dataLines.length === 0
    ) {
      return;
    }

    const rawData =
      dataLines.join("\n");

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
          text?: unknown;
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

  while (true) {
    const {
      value,
      done,
    } =
      await reader.read();

    if (done) {
      break;
    }

    buffer +=
      decoder.decode(
        value,
        {
          stream: true,
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

  if (buffer.trim()) {
    handleEventBlock(
      buffer,
    );
  }
}