const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `http://${window.location.hostname || "127.0.0.1"}:8000`
    : "http://127.0.0.1:8000");

export interface ChatRequest {
  message: string;
  model: string;
  thread_id?: string;
  attachment_ids?: string[];
}

export interface ChatResponse {
  response: string;
  thread_id: string;
}

export interface AttachmentUploadResponse {
  attachment_id: string;
  name: string;
  mime_type: string;
  kind: "document" | "image";
  size: number;
  preview?: string;
}

export interface UploadProgressHandlers {
  onProgress?: (progress: number) => void;
  onError?: (error: string) => void;
}

function getErrorMessage(responseText: string, fallback: string) {
  try {
    const parsed = JSON.parse(responseText) as { detail?: unknown };
    if (typeof parsed.detail === "string" && parsed.detail.trim()) {
      return parsed.detail;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

export function uploadAttachment(
  threadId: string,
  file: File,
  handlers: UploadProgressHandlers = {},
) {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<AttachmentUploadResponse>((resolve, reject) => {
    xhr.open("POST", `${API_URL}/attachments/upload`);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.round((event.loaded / event.total) * 100);
      handlers.onProgress?.(progress);
    };

    xhr.onerror = () => {
      const message = `Upload failed. Could not reach the backend at ${API_URL}. Make sure the Python server is running.`;
      handlers.onError?.(message);
      reject(new Error(message));
    };

    xhr.onabort = () => {
      const message = "Upload canceled.";
      handlers.onError?.(message);
      reject(new Error(message));
    };

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const message = getErrorMessage(
          xhr.responseText,
          "Upload failed. Please try again.",
        );
        handlers.onError?.(message);
        reject(new Error(message));
        return;
      }

      try {
        const response = JSON.parse(xhr.responseText) as AttachmentUploadResponse;
        resolve(response);
      } catch {
        const message = "Upload failed. Please try again.";
        handlers.onError?.(message);
        reject(new Error(message));
      }
    };

    const formData = new FormData();
    formData.append("thread_id", threadId);
    formData.append("file", file);
    xhr.send(formData);
  });

  return {
    promise,
    abort: () => xhr.abort(),
  };
}

export async function chat(
  body: ChatRequest,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  const res = await fetch(`${API_URL}/chat`, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error("Failed to send message");
  }

  return res.json();
}
