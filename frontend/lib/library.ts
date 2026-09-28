export type LibraryFileKind =
  | "image"
  | "document";

export interface LibraryFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: LibraryFileKind;
  createdAt: number;
  updatedAt: number;
  favorite: boolean;
  folderId: string | null;
  blob: Blob;
}

export interface LibraryFolder {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

const DB_NAME =
  "clawbit-library";

const DB_VERSION = 1;

const FILE_STORE = "files";
const FOLDER_STORE = "folders";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise(
    (resolve, reject) => {
      const request =
        indexedDB.open(
          DB_NAME,
          DB_VERSION,
        );

      request.onupgradeneeded =
        () => {
          const database =
            request.result;

          if (
            !database.objectStoreNames.contains(
              FILE_STORE,
            )
          ) {
            const store =
              database.createObjectStore(
                FILE_STORE,
                {
                  keyPath: "id",
                },
              );

            store.createIndex(
              "createdAt",
              "createdAt",
            );

            store.createIndex(
              "folderId",
              "folderId",
            );

            store.createIndex(
              "favorite",
              "favorite",
            );
          }

          if (
            !database.objectStoreNames.contains(
              FOLDER_STORE,
            )
          ) {
            const store =
              database.createObjectStore(
                FOLDER_STORE,
                {
                  keyPath: "id",
                },
              );

            store.createIndex(
              "createdAt",
              "createdAt",
            );
          }
        };

      request.onsuccess = () =>
        resolve(
          request.result,
        );

      request.onerror = () =>
        reject(
          request.error,
        );
    },
  );
}

function requestToPromise<T>(
  request: IDBRequest<T>,
): Promise<T> {
  return new Promise(
    (resolve, reject) => {
      request.onsuccess = () =>
        resolve(
          request.result,
        );

      request.onerror = () =>
        reject(
          request.error,
        );
    },
  );
}

function transactionDone(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise(
    (resolve, reject) => {
      transaction.oncomplete =
        () => resolve();

      transaction.onerror =
        () =>
          reject(
            transaction.error,
          );

      transaction.onabort =
        () =>
          reject(
            transaction.error,
          );
    },
  );
}

/* ====================================================== */
/* FILES                                                  */
/* ====================================================== */

export async function getLibraryFiles(): Promise<
  LibraryFile[]
> {
  const database =
    await openDatabase();

  try {
    const transaction =
      database.transaction(
        FILE_STORE,
        "readonly",
      );

    const store =
      transaction.objectStore(
        FILE_STORE,
      );

    const files =
      (await requestToPromise(
        store.getAll(),
      )) as LibraryFile[];

    await transactionDone(
      transaction,
    );

    return files.sort(
      (left, right) =>
        right.updatedAt -
        left.updatedAt,
    );
  } finally {
    database.close();
  }
}

export async function saveLibraryFile(
  file: File,
  folderId: string | null = null,
): Promise<LibraryFile> {
  const database =
    await openDatabase();

  const now = Date.now();

  const record: LibraryFile = {
    id: crypto.randomUUID(),

    name: file.name,

    mimeType:
      file.type ||
      "application/octet-stream",

    size: file.size,

    kind: file.type.startsWith(
      "image/",
    )
      ? "image"
      : "document",

    createdAt: now,

    updatedAt: now,

    favorite: false,

    folderId,

    blob: file,
  };

  try {
    const transaction =
      database.transaction(
        FILE_STORE,
        "readwrite",
      );

    const store =
      transaction.objectStore(
        FILE_STORE,
      );

    store.put(record);

    await transactionDone(
      transaction,
    );

    return record;
  } finally {
    database.close();
  }
}

export async function updateLibraryFile(
  file: LibraryFile,
): Promise<void> {
  const database =
    await openDatabase();

  try {
    const transaction =
      database.transaction(
        FILE_STORE,
        "readwrite",
      );

    transaction
      .objectStore(
        FILE_STORE,
      )
      .put({
        ...file,
        updatedAt: Date.now(),
      });

    await transactionDone(
      transaction,
    );
  } finally {
    database.close();
  }
}

export async function renameLibraryFile(
  file: LibraryFile,
  name: string,
): Promise<void> {
  const trimmed =
    name.trim();

  if (!trimmed) {
    return;
  }

  await updateLibraryFile({
    ...file,
    name: trimmed,
  });
}

export async function deleteLibraryFile(
  id: string,
): Promise<void> {
  const database =
    await openDatabase();

  try {
    const transaction =
      database.transaction(
        FILE_STORE,
        "readwrite",
      );

    transaction
      .objectStore(
        FILE_STORE,
      )
      .delete(id);

    await transactionDone(
      transaction,
    );
  } finally {
    database.close();
  }
}

/* ====================================================== */
/* FOLDERS                                                */
/* ====================================================== */

export async function getLibraryFolders(): Promise<
  LibraryFolder[]
> {
  const database =
    await openDatabase();

  try {
    const transaction =
      database.transaction(
        FOLDER_STORE,
        "readonly",
      );

    const folders =
      (await requestToPromise(
        transaction
          .objectStore(
            FOLDER_STORE,
          )
          .getAll(),
      )) as LibraryFolder[];

    await transactionDone(
      transaction,
    );

    return folders.sort(
      (left, right) =>
        left.name.localeCompare(
          right.name,
        ),
    );
  } finally {
    database.close();
  }
}

export async function createLibraryFolder(
  name: string,
): Promise<LibraryFolder> {
  const trimmed =
    name.trim();

  if (!trimmed) {
    throw new Error(
      "Folder name is required.",
    );
  }

  const now = Date.now();

  const folder: LibraryFolder =
    {
      id: crypto.randomUUID(),
      name: trimmed,
      createdAt: now,
      updatedAt: now,
    };

  const database =
    await openDatabase();

  try {
    const transaction =
      database.transaction(
        FOLDER_STORE,
        "readwrite",
      );

    transaction
      .objectStore(
        FOLDER_STORE,
      )
      .put(folder);

    await transactionDone(
      transaction,
    );

    return folder;
  } finally {
    database.close();
  }
}

export async function renameLibraryFolder(
  folder: LibraryFolder,
  name: string,
): Promise<void> {
  const trimmed =
    name.trim();

  if (!trimmed) {
    return;
  }

  const database =
    await openDatabase();

  try {
    const transaction =
      database.transaction(
        FOLDER_STORE,
        "readwrite",
      );

    transaction
      .objectStore(
        FOLDER_STORE,
      )
      .put({
        ...folder,
        name: trimmed,
        updatedAt: Date.now(),
      });

    await transactionDone(
      transaction,
    );
  } finally {
    database.close();
  }
}

export async function deleteLibraryFolder(
  folderId: string,
): Promise<void> {
  /*
   * Delete the folder itself first.
   */
  {
    const database =
      await openDatabase();

    try {
      const transaction =
        database.transaction(
          FOLDER_STORE,
          "readwrite",
        );

      transaction
        .objectStore(
          FOLDER_STORE,
        )
        .delete(folderId);

      await transactionDone(
        transaction,
      );
    } finally {
      database.close();
    }
  }

  /*
   * Files inside the deleted folder are
   * moved back to the main Library.
   */
  const files =
    await getLibraryFiles();

  const affected =
    files.filter(
      (file) =>
        file.folderId ===
        folderId,
    );

  await Promise.all(
    affected.map((file) =>
      updateLibraryFile({
        ...file,
        folderId: null,
      }),
    ),
  );
}

/* ====================================================== */
/* DOWNLOAD                                               */
/* ====================================================== */

export function downloadLibraryFile(
  file: LibraryFile,
) {
  const url =
    URL.createObjectURL(
      file.blob,
    );

  const anchor =
    document.createElement(
      "a",
    );

  anchor.href = url;
  anchor.download = file.name;

  document.body.appendChild(
    anchor,
  );

  anchor.click();

  anchor.remove();

  window.setTimeout(
    () =>
      URL.revokeObjectURL(
        url,
      ),
    1000,
  );
}

/* ====================================================== */
/* DISPLAY                                                */
/* ====================================================== */

export function formatLibraryFileSize(
  bytes: number,
) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kilobytes =
    bytes / 1024;

  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(
      1,
    )} KB`;
  }

  const megabytes =
    kilobytes / 1024;

  if (megabytes < 1024) {
    return `${megabytes.toFixed(
      1,
    )} MB`;
  }

  return `${(
    megabytes / 1024
  ).toFixed(1)} GB`;
}