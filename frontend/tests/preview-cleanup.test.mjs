
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";

import auth from "../lib/auth.ts";
import previews from "../lib/chatAttachmentPreviews.ts";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalIndexedDB = globalThis.indexedDB;
const originalCustomEvent = globalThis.CustomEvent;

const principal = "b".repeat(64);
const session = {
  user: {
    username: "offline-owner",
    principal_id: principal,
  },
  csrf_token: "a".repeat(64),
  expires_at: Date.now() / 1000 + 3600,
};

function fakeIndexedDB() {
  const databases = new Map();

  function requestFrom(operation) {
    const request = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };

    queueMicrotask(() => {
      try {
        request.result = operation(request);
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
      }
    });

    return request;
  }

  function makeDatabase() {
    const stores = new Map();

    return {
      stores,
      objectStoreNames: {
        contains(name) {
          return stores.has(name);
        },
      },
      createObjectStore(name) {
        const store = new Map();
        stores.set(name, store);
        return store;
      },
      close() {},
      onversionchange: null,
      transaction(name) {
        if (!stores.has(name)) {
          throw new Error("Unknown object store.");
        }

        const entries = stores.get(name);
        let pending = 0;

        const transaction = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: null,
          objectStore() {
            function operation(callback) {
              pending++;

              queueMicrotask(() => {
                callback();
                pending--;

                if (pending === 0) {
                  queueMicrotask(() => {
                    transaction.oncomplete?.();
                  });
                }
              });
            }

            return {
              put(record) {
                operation(() => {
                  entries.set(record.id, record);
                });
              },
              delete(id) {
                operation(() => {
                  entries.delete(id);
                });
              },
              get(id) {
                const request = {
                  result: undefined,
                  error: null,
                  onsuccess: null,
                  onerror: null,
                };

                operation(() => {
                  request.result = entries.get(id);
                  request.onsuccess?.();
                });

                return request;
              },
            };
          },
        };

        return transaction;
      },
    };
  }

  return {
    databases,
    open(name) {
      return requestFrom((request) => {
        let database = databases.get(name);

        if (!database) {
          database = makeDatabase();
          databases.set(name, database);
          request.result = database;
          request.onupgradeneeded?.();
        }

        return database;
      });
    },
    deleteDatabase(name) {
      return requestFrom(() => {
        databases.delete(name);
        return undefined;
      });
    },
  };
}

let fakeStorage;

async function signIn() {
  globalThis.fetch = async () => Response.json(session);
  await auth.restoreSession();

  assert.equal(
    auth.getAuthState().status,
    "authenticated",
  );
}

function sampleFile(name = "notes.txt") {
  return {
    name,
    type: "text/plain",
    size: 12,
  };
}

beforeEach(async () => {
  auth.expireSession();
  await previews.waitForChatAttachmentPreviewCleanup();

  fakeStorage = fakeIndexedDB();
  globalThis.indexedDB = fakeStorage;

  globalThis.window = {
    dispatchEvent() {},
  };

  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };

  globalThis.fetch = async () => {
    throw new Error("Unexpected network request.");
  };
});

afterEach(async () => {
  auth.expireSession();
  await previews.waitForChatAttachmentPreviewCleanup();

  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.indexedDB = originalIndexedDB;
  globalThis.CustomEvent = originalCustomEvent;
});

test("deleting one preview retains unrelated previews", async () => {
  await signIn();

  await previews.saveChatAttachmentPreview(
    "attachment-one",
    sampleFile("one.txt"),
    "document",
  );

  await previews.saveChatAttachmentPreview(
    "attachment-two",
    sampleFile("two.txt"),
    "document",
  );

  assert.equal(
    (
      await previews.getChatAttachmentPreviews([
        "attachment-one",
        "attachment-two",
      ])
    ).length,
    2,
  );

  await previews.deleteChatAttachmentPreviews([
    "attachment-one",
  ]);

  const remaining = await previews.getChatAttachmentPreviews([
    "attachment-one",
    "attachment-two",
  ]);

  assert.deepEqual(
    remaining.map((item) => item.id),
    ["attachment-two"],
  );
});

test("deleted preview cannot be recreated by a delayed save", async () => {
  await signIn();

  await previews.deleteChatAttachmentPreviews([
    "attachment-deleted",
  ]);

  await previews.saveChatAttachmentPreview(
    "attachment-deleted",
    sampleFile(),
    "document",
  );

  assert.deepEqual(
    await previews.getChatAttachmentPreviews([
      "attachment-deleted",
    ]),
    [],
  );
});

test("session expiry purges browser previews", async () => {
  await signIn();

  await previews.saveChatAttachmentPreview(
    "attachment-expiry",
    sampleFile(),
    "document",
  );

  assert.equal(
    fakeStorage.databases.has(
      "clawbit-chat-attachment-previews",
    ),
    true,
  );

  auth.expireSession();

  await previews.waitForChatAttachmentPreviewCleanup();

  assert.equal(
    fakeStorage.databases.has(
      "clawbit-chat-attachment-previews",
    ),
    false,
  );
});

test("a pending save cannot resurrect data after logout", async () => {
  await signIn();

  const pending = previews.saveChatAttachmentPreview(
    "attachment-pending",
    sampleFile(),
    "document",
  );

  auth.expireSession();

  await pending;
  await previews.waitForChatAttachmentPreviewCleanup();

  assert.equal(
    fakeStorage.databases.has(
      "clawbit-chat-attachment-previews",
    ),
    false,
  );
});

test("signOut completes preview purge after server logout", async () => {
  await signIn();

  await previews.saveChatAttachmentPreview(
    "attachment-logout",
    sampleFile(),
    "document",
  );

  globalThis.fetch = async (url) => {
    assert.match(url, /\/auth\/logout$/);
    return Response.json({ success: true });
  };

  await auth.signOut();

  assert.equal(
    auth.getAuthState().status,
    "anonymous",
  );

  assert.equal(
    fakeStorage.databases.has(
      "clawbit-chat-attachment-previews",
    ),
    false,
  );
});

test("conversation and message deletion include preview cleanup", () => {
  const shell = readFileSync(
    new URL("../components/layout/AppShell.tsx", import.meta.url),
    "utf8",
  );

  const chat = readFileSync(
    new URL("../hooks/useChat.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    shell,
    /await deleteHistory\(saved\)/,
  );

  assert.match(
    shell,
    /await deleteChatAttachmentPreviews\(attachmentIds\)/,
  );

  assert.match(
    chat,
    /deleteChatAttachmentPreviews\(removedIds\)/,
  );
});
