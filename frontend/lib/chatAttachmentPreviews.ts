
import {
  getAuthState,
  subscribeAuth,
} from "@/lib/auth";

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

let generation = 0;
let pendingMutations: Promise<void> = Promise.resolve();
let previousOwner = getAuthState().user?.principal_id ?? null;

const deletedIds = new Set<string>();

function currentOwner(): string | null {
  const state = getAuthState();
  return state.status === "authenticated"
    ? state.user?.principal_id ?? null
    : null;
}

function queueMutation(
  operation: () => Promise<void>,
): Promise<void> {
  const result = pendingMutations.then(operation, operation);
  pendingMutations = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function emitChange(id: string): void {
  if (typeof window === "undefined") return;

  window.dispatchEvent(
    new CustomEvent(UPDATE_EVENT, {
      detail: { id },
    }),
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Browser preview storage is unavailable."));
      return;
    }

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

    request.onsuccess = () => {
      const database = request.result;

      // Allow another tab to delete the database on logout.
      database.onversionchange = () => database.close();

      resolve(database);
    };

    request.onerror = () =>
      reject(
        request.error ??
          new Error("Cannot open preview storage."),
      );
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

      canvas.width = Math.max(
        1,
        Math.round(image.width * scale),
      );
      canvas.height = Math.max(
        1,
        Math.round(image.height * scale),
      );

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
    return file.size <= 1024 * 1024 ? file : null;
  }
}

export async function saveChatAttachmentPreview(
  id: string,
  file: File,
  kind: ChatAttachmentKind,
): Promise<void> {
  const owner = currentOwner();
  if (!owner || !id.trim() || deletedIds.has(id)) return;

  const startedGeneration = generation;

  const thumbnail =
    kind === "image" ? await createThumbnail(file) : null;

  await queueMutation(async () => {
    if (
      generation !== startedGeneration ||
      currentOwner() !== owner ||
      deletedIds.has(id)
    ) {
      return;
    }

    const record: ChatAttachmentPreview = {
      id,
      name: file.name,
      kind,
      mimeType: file.type || "application/octet-stream",
      thumbnail,
    };

    const database = await openDatabase();

    try {
      // Recheck after the asynchronous database open.
      if (
        generation !== startedGeneration ||
        currentOwner() !== owner ||
        deletedIds.has(id)
      ) {
        return;
      }

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

    if (
      generation === startedGeneration &&
      currentOwner() === owner &&
      !deletedIds.has(id)
    ) {
      emitChange(id);
    }
  });
}

export async function getChatAttachmentPreviews(
  ids: string[],
): Promise<ChatAttachmentPreview[]> {
  const owner = currentOwner();
  const startedGeneration = generation;

  if (!owner || !ids.length) return [];

  // Wait for queued deletions before reading the database.
  await pendingMutations;

  if (
    generation !== startedGeneration ||
    currentOwner() !== owner
  ) {
    return [];
  }

  const database = await openDatabase();

  try {
    if (
      generation !== startedGeneration ||
      currentOwner() !== owner
    ) {
      return [];
    }

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
              if (deletedIds.has(id)) {
                resolve(null);
                return;
              }

              const request = store.get(id);

              request.onsuccess = () =>
                resolve(
                  (request.result as
                    | ChatAttachmentPreview
                    | undefined) ?? null,
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

    if (
      generation !== startedGeneration ||
      currentOwner() !== owner
    ) {
      return [];
    }

    return results.filter(
      (item): item is ChatAttachmentPreview =>
        item !== null && !deletedIds.has(item.id),
    );
  } finally {
    database.close();
  }
}

export function deleteChatAttachmentPreviews(
  ids: string[],
): Promise<void> {
  const owner = currentOwner();
  if (!owner) return Promise.resolve();

  const uniqueIds = [
    ...new Set(ids.filter((id) => typeof id === "string" && id.length > 0)),
  ];

  if (!uniqueIds.length) return Promise.resolve();

  uniqueIds.forEach((id) => deletedIds.add(id));

  return queueMutation(async () => {
    if (currentOwner() !== owner) return;

    const database = await openDatabase();

    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(
          STORE_NAME,
          "readwrite",
        );
        const store = transaction.objectStore(STORE_NAME);

        uniqueIds.forEach((id) => store.delete(id));

        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ??
              new Error("Cannot delete attachment previews."),
          );
        transaction.onabort = () =>
          reject(
            transaction.error ??
              new Error("Attachment preview deletion was cancelled."),
          );
      });
    } finally {
      database.close();
    }

    uniqueIds.forEach(emitChange);
  });
}

export function purgeAllChatAttachmentPreviews(): Promise<void> {
  // Invalidate pending image compression and saved-preview writes
  // immediately, before the asynchronous deletion begins.
  generation += 1;
  deletedIds.clear();

  return queueMutation(async () => {
    if (typeof indexedDB === "undefined") return;

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DATABASE_NAME);

      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(
          request.error ??
            new Error("Cannot clear attachment previews."),
        );
      request.onblocked = () =>
        reject(
          new Error("Another tab is blocking preview cleanup."),
        );
    });

    emitChange("");
  });
}

export function waitForChatAttachmentPreviewCleanup(): Promise<void> {
  return pendingMutations;
}

// Covers explicit logout, session expiry, 401, and owner changes.
subscribeAuth(() => {
  const nextOwner = currentOwner();

  if (previousOwner && previousOwner !== nextOwner) {
    void purgeAllChatAttachmentPreviews().catch(() => {
      // The session is already revoked. Never restore access merely
      // because browser storage could not be cleared.
    });
  }

  previousOwner = nextOwner;
});

export const CHAT_ATTACHMENT_PREVIEW_EVENT = UPDATE_EVENT;
