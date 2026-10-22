
export type ChatAttachmentKind = "image" | "document";

export interface ChatAttachmentPreview {
  id: string;
  name: string;
  kind: ChatAttachmentKind;
  mimeType: string;
  thumbnail: Blob | null;
}

const DATABASE_NAME = "clawbit-chat-attachment-previews";
const DATABASE_VERSION = 1;
const STORE_NAME = "previews";
const UPDATE_EVENT = "clawbit:chat-attachment-preview-saved";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      DATABASE_NAME,
      DATABASE_VERSION,
    );

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, {
          keyPath: "id",
        });
      }
    };

    request.onsuccess = () => resolve(request.result);

    request.onerror = () =>
      reject(request.error ?? new Error("Cannot open preview storage."));
  });
}

async function createThumbnail(file: File): Promise<Blob | null> {
  if (!file.type.startsWith("image/")) return null;

  try {
    const image = await createImageBitmap(file);

    try {
      const maxDimension = 1280;
      const scale = Math.min(
        1,
        maxDimension / Math.max(image.width, image.height),
      );

      const canvas = document.createElement("canvas");

      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));

      const context = canvas.getContext("2d");

      if (!context) return null;

      context.drawImage(
        image,
        0,
        0,
        canvas.width,
        canvas.height,
      );

      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/webp", 0.82);
      });
    } finally {
      image.close();
    }
  } catch {
    // Some formats and browsers cannot create ImageBitmaps.
    // Use the original only when its size is reasonably small.
    return file.size <= 1024 * 1024 ? file : null;
  }
}

export async function saveChatAttachmentPreview(
  id: string,
  file: File,
  kind: ChatAttachmentKind,
): Promise<void> {
  if (!id.trim()) return;

  const thumbnail =
    kind === "image" ? await createThumbnail(file) : null;

  const record: ChatAttachmentPreview = {
    id,
    name: file.name,
    kind,
    mimeType: file.type || "application/octet-stream",
    thumbnail,
  };

  const database = await openDatabase();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        STORE_NAME,
        "readwrite",
      );

      transaction.objectStore(STORE_NAME).put(record);

      transaction.oncomplete = () => resolve();

      transaction.onerror = () =>
        reject(
          transaction.error ??
            new Error("Cannot save attachment preview."),
        );

      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error("Attachment preview save was cancelled."),
        );
    });
  } finally {
    database.close();
  }

  window.dispatchEvent(
    new CustomEvent(UPDATE_EVENT, {
      detail: { id },
    }),
  );
}

export async function getChatAttachmentPreviews(
  ids: string[],
): Promise<ChatAttachmentPreview[]> {
  if (!ids.length) return [];

  const database = await openDatabase();

  try {
    const transaction = database.transaction(
      STORE_NAME,
      "readonly",
    );

    const store = transaction.objectStore(STORE_NAME);

    const results = await Promise.all(
      ids.map(
        (id) =>
          new Promise<ChatAttachmentPreview | null>(
            (resolve, reject) => {
              const request = store.get(id);

              request.onsuccess = () =>
                resolve(
                  (request.result as ChatAttachmentPreview | undefined) ??
                    null,
                );

              request.onerror = () =>
                reject(
                  request.error ??
                    new Error("Cannot read attachment preview."),
                );
            },
          ),
      ),
    );

    return results.filter(
      (item): item is ChatAttachmentPreview => item !== null,
    );
  } finally {
    database.close();
  }
}

export const CHAT_ATTACHMENT_PREVIEW_EVENT = UPDATE_EVENT;
