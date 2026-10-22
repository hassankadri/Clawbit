import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import auth from "../lib/auth.ts";
import history from "../lib/history.ts";
import api from "../lib/api.ts";
import HookModule from "../hooks/useChat.ts";
import { hookHarness } from "./hook-harness.mjs";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalStream = api.streamChat;
const originalCreate = history.createHistory;
const originalLoad = history.loadHistory;
const principal = "b".repeat(64);
const tick = () => new Promise((resolve) => setImmediate(resolve));
let storage;

function saved(messages = [], version = 0, thread = "saved-thread") {
  return {
    id: `display-${thread}`, thread_id: thread, workspace_id: "workspace",
    title: "Saved", model: "gemini-3.1-flash-lite", mode: "normal", pinned: false,
    createdAt: 100, updatedAt: 200, version, revision_id: null, messages,
  };
}

beforeEach(async () => {
  auth.expireSession();
  storage = new Map([["clawbit-browser-owner-v1", principal]]);
  globalThis.window = {
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    dispatchEvent() {}, confirm: () => true,
  };
  globalThis.fetch = async () => Response.json({
    user: { username: "fixture", principal_id: principal },
    csrf_token: "a".repeat(64), expires_at: Date.now() / 1000 + 3600,
  });
  await auth.restoreSession();
});

afterEach(() => {
  auth.expireSession();
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  api.streamChat = originalStream;
  history.createHistory = originalCreate;
  history.loadHistory = originalLoad;
});

test("history requests retain cookies, CSRF, versions and stable identifiers", async () => {
  const calls = [];
  const record = saved();
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json(record);
  };
  await history.createHistory({ id: record.id, thread_id: record.thread_id, workspace_id: record.workspace_id, model: record.model, mode: record.mode, title: record.title });
  await history.updateHistory(record, { title: "Renamed" });
  await history.deleteHistory(record);
  assert.ok(calls.every((call) => call.options.credentials === "include"));
  assert.ok(calls.every((call) => new Headers(call.options.headers).get("X-CSRF-Token")));
  assert.equal(JSON.parse(calls[0].options.body).workspace_id, "workspace");
  assert.equal(JSON.parse(calls[1].options.body).version, 0);
  assert.match(calls[2].url, /version=0$/);
});

test("browser import preserves original storage and sends stable data on retry", async () => {
  const item = {
    id: "legacy", title: "Old", updatedAt: 123, workspaceId: "workspace",
    snapshot: { threadId: "saved-thread", model: saved().model, messages: [
      { id: "old-message", role: "assistant", content: "partial", status: "streaming" },
    ] },
  };
  storage.set("clawbit.conversations.v1", JSON.stringify([item]));
  const before = new Map(storage);
  const imports = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/import")) imports.push(JSON.parse(options.body));
    return Response.json(saved());
  };
  await history.importLegacyConversation(item, principal);
  await history.importLegacyConversation(item, principal);
  assert.deepEqual(imports[0], imports[1]);
  assert.equal(imports[0].messages[0].id, "old-message");
  assert.equal(imports[0].messages[0].status, "cancelled");
  assert.equal(imports[0].messages[0].createdAt, 123);
  assert.deepEqual(storage, before);
});

test("browser import fails before transmission for a foreign principal or profile", async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("must not transmit"); };
  await assert.rejects(history.importLegacyConversation({}, "foreign"), /does not belong/);
  storage.set("clawbit-browser-owner-v1", "another-owner");
  await assert.rejects(history.importLegacyConversation({}, principal), /does not belong/);
  assert.equal(requests, 0);
});

test("import conflicts surface without modifying either browser payload", async () => {
  const item = { id: "old", title: "Old", updatedAt: 10, snapshot: { threadId: "saved-thread", model: saved().model, messages: [] } };
  storage.set("clawbit.conversations.v1", "original payload");
  globalThis.fetch = async (url) => url.endsWith("/import")
    ? Response.json({ detail: "Import conflicts with saved server history." }, { status: 409 })
    : Response.json(saved());
  await assert.rejects(history.importLegacyConversation(item, principal), (error) => error.status === 409);
  assert.equal(storage.get("clawbit.conversations.v1"), "original payload");
});

test("malformed browser history is rejected without changing storage", () => {
  for (const raw of ["{broken", "{}", '[{"id":"missing-snapshot"}]']) {
    storage.set("clawbit.conversations.v1", raw);
    assert.throws(() => history.parseLegacyArray(raw, history.isLegacyConversation));
    assert.equal(storage.get("clawbit.conversations.v1"), raw);
  }
  const item = { id: "old", title: "Old", updatedAt: 10, snapshot: { threadId: "old-thread", model: saved().model, messages: [] } };
  assert.deepEqual(history.parseLegacyArray(JSON.stringify([item]), history.isLegacyConversation), [item]);
  assert.deepEqual(history.parseLegacyArray(null, history.isLegacyConversation), []);
});

test("unreadable history responses report a safe error without reflecting the body", async () => {
  globalThis.fetch = async () => new Response("private server diagnostic", { status: 503 });
  await assert.rejects(history.loadHistory("saved-thread"), (error) => {
    assert.equal(error.status, 503);
    assert.match(error.message, /unreadable response/);
    assert.doesNotMatch(error.message, /private server/);
    return true;
  });
});

test("restoration keeps new chats empty and selects only the requested workspace", () => {
  const standalone = { id: "chat", snapshot: history.historySnapshot(saved([], 2, "chat")) };
  const project = { id: "project-chat", snapshot: { ...standalone.snapshot, threadId: "project-chat", workspaceId: "project" } };
  const records = [standalone, project];
  assert.equal(history.selectSavedConversation(records, "new-chat", null), undefined);
  assert.equal(history.selectSavedConversation(records, "chat", null), standalone);
  assert.equal(history.selectSavedConversation(records, "chat", "project"), project);
  assert.equal(history.selectSavedConversation(records, "chat", "another-project"), undefined);
});

function streamFixture() {
  const requests = [];
  api.streamChat = (body, handlers, signal) => new Promise((resolve) => requests.push({ body, handlers, signal, resolve }));
  return requests;
}

test("persistent send uses server version and reconciles exact stored messages", async () => {
  const requests = streamFixture();
  const hook = hookHarness(() => HookModule.default({ persistent: true }));
  let server;
  history.createHistory = async (body) => (server = { ...saved(), ...body });
  history.loadHistory = async () => server;
  try {
    const pending = hook.render().sendMessage("question", ["attachment"], { conversationId: "display", workspaceId: "workspace" });
    await tick();
    const request = requests[0];
    assert.equal(request.body.expected_version, 0);
    assert.equal(request.body.workspace_id, "workspace");
    assert.deepEqual(request.body.attachment_ids, ["attachment"]);
    assert.ok(request.body.request_id && request.body.user_message_id && request.body.assistant_message_id);
    request.handlers.onToken("answer");
    server = { ...server, version: 2, messages: [
      { id: request.body.user_message_id, role: "user", content: "question", status: "complete", attachmentIds: ["attachment"] },
      { id: request.body.assistant_message_id, role: "assistant", content: "answer", status: "complete" },
    ] };
    request.handlers.onDone({ thread_id: request.body.thread_id });
    request.resolve();
    await pending;
    assert.deepEqual(hook.render().messages, server.messages);
    assert.equal(hook.render().createSnapshot().historyVersion, 2);
    assert.equal(hook.render().loading, false);
  } finally { hook.close(); }
});

test("persistent cancellation waits for the durable terminal state without another inference", async () => {
  const requests = streamFixture();
  const server = saved([], 0);
  let reads = 0;
  history.createHistory = async (body) => ({ ...server, ...body });
  history.loadHistory = async () => ({ ...server, running: ++reads === 1 });
  const hook = hookHarness(() => HookModule.default({ persistent: true }));
  try {
    const pending = hook.render().sendMessage("question");
    await tick();
    requests[0].handlers.onToken("partial");
    hook.render().stopGeneration();
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(hook.render().historyLoading, true);
    server.messages = [
      { id: requests[0].body.user_message_id, role: "user", content: "question", status: "complete" },
      { id: requests[0].body.assistant_message_id, role: "assistant", content: "partial", status: "cancelled" },
    ];
    requests[0].resolve();
    await pending;
    assert.equal(reads, 2);
    assert.equal(requests.length, 1);
    assert.deepEqual(hook.render().messages, server.messages);
    assert.equal(hook.render().historyLoading, false);
  } finally { hook.close(); }
});

test("cancelling while history creation is pending never dispatches inference", async () => {
  const requests = streamFixture();
  let release;
  history.createHistory = (body) => new Promise((resolve) => { release = () => resolve({ ...saved(), ...body }); });
  const hook = hookHarness(() => HookModule.default({ persistent: true }));
  try {
    const pending = hook.render().sendMessage("question");
    hook.render().stopGeneration();
    release();
    await pending;
    assert.equal(requests.length, 0);
    assert.equal(hook.render().messages.at(-1).status, "cancelled");
    assert.equal(hook.render().historyLoading, false);
    assert.equal(hook.render().loading, false);
  } finally { hook.close(); }
});

test("older edit targets stable ID with attachments and restores valid history on failure", async () => {
  const requests = streamFixture();
  const server = saved([
    { id: "user-old", role: "user", content: "original", status: "complete", attachmentIds: ["doc"] },
    { id: "answer-old", role: "assistant", content: "valid answer", status: "complete" },
    { id: "user-later", role: "user", content: "later", status: "complete" },
    { id: "answer-later", role: "assistant", content: "later answer", status: "complete" },
  ], 4);
  history.loadHistory = async () => server;
  const hook = hookHarness(() => HookModule.default({ persistent: true }));
  try {
    hook.render().restoreSnapshot(history.historySnapshot(server));
    await tick();
    const pending = hook.render().editMessage("user-old", "edited");
    await tick();
    assert.equal(requests[0].body.operation, "edit");
    assert.equal(requests[0].body.target_message_id, "user-old");
    assert.deepEqual(requests[0].body.attachment_ids, ["doc"]);
    requests[0].handlers.onError({ message: "Provider unavailable.", status_code: 503 });
    requests[0].resolve();
    await pending;
    assert.deepEqual(hook.render().messages, server.messages);
    assert.match(hook.render().historyError, /previous conversation is preserved/);
  } finally { hook.close(); }
});

test("retry distinguishes failed responses from completed regeneration", async () => {
  for (const status of ["error", "cancelled", "complete"]) {
    const requests = streamFixture();
    const server = saved([
      { id: "user", role: "user", content: "question", attachmentIds: ["doc"] },
      { id: "answer", role: "assistant", content: "answer", status },
    ], 2);
    history.loadHistory = async () => server;
    const hook = hookHarness(() => HookModule.default({ persistent: true }));
    try {
      hook.render().restoreSnapshot(history.historySnapshot(server));
      await tick();
      const pending = hook.render().retryAssistantMessage("answer");
      await tick();
      assert.equal(requests[0].body.operation, status === "complete" ? "regenerate" : "retry");
      assert.equal(requests[0].body.target_message_id, "answer");
      assert.equal(requests[0].body.user_message_id, "user");
      assert.deepEqual(requests[0].body.attachment_ids, ["doc"]);
      requests[0].handlers.onError({ message: "Stopped", status_code: 409 });
      requests[0].resolve();
      await pending;
    } finally { hook.close(); }
  }
});

test("late history loads cannot replace a different selected conversation", async () => {
  const loads = [];
  history.loadHistory = (thread, signal) => new Promise((resolve) => loads.push({ thread, signal, resolve }));
  const hook = hookHarness(() => HookModule.default({ persistent: true }));
  try {
    hook.render().restoreSnapshot(history.historySnapshot(saved([], 2, "old")));
    hook.render().restoreSnapshot(history.historySnapshot(saved([], 2, "new")));
    assert.equal(loads[0].signal.aborted, true);
    loads[1].resolve(saved([{ id: "new-message", role: "user", content: "new" }], 2, "new"));
    await tick();
    loads[0].resolve(saved([{ id: "old-message", role: "user", content: "old" }], 2, "old"));
    await tick();
    assert.equal(hook.render().threadId, "new");
    assert.equal(hook.render().messages[0].id, "new-message");
  } finally { hook.close(); }
});

test("unimported local conversations cannot silently enter a persistent request", async () => {
  const requests = streamFixture();
  history.createHistory = async () => { assert.fail("must not create imported history implicitly"); };
  const hook = hookHarness(() => HookModule.default({ persistent: true }));
  try {
    hook.render().restoreSnapshot({ threadId: "legacy", model: saved().model, messages: [{ id: "old", role: "user", content: "legacy" }] });
    await hook.render().sendMessage("continue");
    assert.equal(requests.length, 0);
    assert.match(hook.render().messages.at(-1).error, /Import this browser conversation/);
    assert.equal(hook.render().messages[0].content, "legacy");
  } finally { hook.close(); }
});
