import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import React from "react";
import { hookHarness } from "./hook-harness.mjs";
import { renderToStaticMarkup } from "react-dom/server";
import api from "../lib/api.ts";
import auth from "../lib/auth.ts";
import HookModule from "../hooks/useChat.ts";
import AssistantModule from "../components/chat/AssistantMessage.tsx";

const originalFetch = globalThis.fetch;
const originalStream = api.streamChat;
const encoder = new TextEncoder();
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const start = frame("start", { thread_id: "thread" });
const done = frame("done", { thread_id: "thread" });

beforeEach(async () => {
  auth.expireSession();
  globalThis.fetch = async () => Response.json({
    user: { username: "fixture-owner", principal_id: "b".repeat(64) },
    csrf_token: "a".repeat(64), expires_at: Date.now() / 1000 + 3600,
  });
  await auth.restoreSession();
});

afterEach(() => {
  auth.expireSession();
  globalThis.fetch = originalFetch;
  api.streamChat = originalStream;
});

function transport() {
  let controller;
  let cancelled = 0;
  let aborted = false;
  globalThis.fetch = async (_, options) => {
    const body = new ReadableStream({
      start(value) {
        controller = value;
        options.signal.addEventListener("abort", () => {
          aborted = true;
          controller.error(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      },
      cancel() { cancelled++; },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };
  return {
    push: (text) => controller.enqueue(encoder.encode(text)),
    bytes: (data) => controller.enqueue(data),
    close: () => controller.close(),
    get cancelled() { return cancelled; },
    get aborted() { return aborted; },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("progressive frames preserve split UTF-8, whitespace and partial Markdown", async () => {
  const source = transport();
  const events = [];
  const text = "  ```python\nprint('雪 😀')\n```\n\nDone.  ";
  const request = api.streamChat({ message: "hi" }, {
    onStart: () => events.push("start"),
    onToken: (token) => events.push(token),
    onDone: () => events.push("done"),
  });
  await tick();
  source.push(start.replaceAll("\n", "\r\n"));
  const first = "  ```python\n";
  source.push(frame("token", { text: first }));
  await tick();
  assert.deepEqual(events, ["start", first]);
  const bytes = encoder.encode(frame("token", { text: text.slice(first.length) }));
  for (const byte of bytes) source.bytes(new Uint8Array([byte]));
  source.push(done);
  await request;
  assert.equal(events.slice(1, -1).join(""), text);
  assert.equal(events.at(-1), "done");
  // Terminal handling finishes even if the server does not close the connection.
  assert.equal(source.aborted, true);
});

test("SSE error is terminal and later tokens cannot reach the UI", async () => {
  const events = [];
  globalThis.fetch = async () => new Response(start
    + frame("token", { text: "partial" })
    + frame("error", { message: "Quota reached.", status_code: 429, retry_after: 7 })
    + frame("token", { text: "late" }) + done);
  await api.streamChat({ message: "hi" }, {
    onToken: (text) => events.push(text),
    onDone: () => events.push("done"),
    onError: (error) => events.push(error),
  });
  assert.deepEqual(events, ["partial", {
    message: "Quota reached. Try again in 7 seconds.", status_code: 429, retry_after: 7,
  }]);
});

for (const [name, payload] of [
  ["closure after partial text", start + frame("token", { text: "partial" })],
  ["invalid JSON", start + "event: token\ndata: {bad JSON}\n\n"],
  ["invalid token type", start + frame("token", { text: 7 })],
  ["invalid status type", start + frame("error", { message: "bad", status_code: "429" })],
  ["mismatched thread", start + frame("done", { thread_id: "other-thread" })],
  ["incomplete terminal frame", start + done.trimEnd()],
  ["oversized frame", "event: token\ndata: " + "x".repeat(1024 * 1024 + 1)],
]) {
  test(`invalid stream rejects: ${name}`, async () => {
    globalThis.fetch = async () => new Response(payload);
    let complete = false;
    await assert.rejects(api.streamChat({ message: "hi" }, {
      onDone: () => { complete = true; },
    }), api.ChatStreamError);
    assert.equal(complete, false);
  });
}

test("malformed UTF-8 fails safely without reflecting frame contents", async () => {
  globalThis.fetch = async () => new Response(new Uint8Array([255, 254]));
  await assert.rejects(api.streamChat({ message: "hi" }, {}), /stream was interrupted/);
});

test("HTTP failures preserve category and retry information", async () => {
  for (const status of [403, 404, 429, 503, 504]) {
    globalThis.fetch = async () => Response.json({ detail: "Safe failure." }, {
      status, headers: { "Retry-After": "13" },
    });
    await assert.rejects(api.streamChat({ message: "hi" }, {}), (error) => {
      assert.equal(error.status_code, status);
      assert.equal(error.retry_after, 13);
      assert.match(error.message, /Try again in 13 seconds/);
      return true;
    });
  }
});

test("session expiry after SSE headers invalidates authenticated state", async () => {
  globalThis.fetch = async () => new Response(start
    + frame("error", { message: "Sign in again.", status_code: 401 }));
  const errors = [];
  await api.streamChat({ message: "hi" }, { onError: (error) => errors.push(error) });
  assert.equal(auth.getAuthState().status, "anonymous");
  assert.equal(errors.length, 1);
});

test("abort before the first token releases the stream reader", async () => {
  const source = transport();
  const controller = new AbortController();
  const events = [];
  const request = api.streamChat({ message: "hi" }, {
    onToken: (text) => events.push(text), onDone: () => events.push("done"),
  }, controller.signal);
  await tick();
  source.push(start);
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.deepEqual(events, []);
});


function controlledRequests() {
  const requests = [];
  api.streamChat = (body, handlers, signal) => new Promise((resolve) => {
    requests.push({ body, handlers, signal, resolve });
  });
  return requests;
}

test("cancel retains partial text and stale callbacks cannot affect a newer conversation", async () => {
  const requests = controlledRequests();
  const hook = hookHarness(() => HookModule.default());
  try {
    let chat = hook.render();
    const old = chat.sendMessage("first");
    requests[0].handlers.onToken("partial");
    hook.render().stopGeneration();
    chat = hook.render();
    assert.equal(chat.messages.at(-1).content, "partial");
    assert.equal(chat.messages.at(-1).status, "cancelled");
    assert.equal(requests[0].signal.aborted, true);
    chat.restoreSnapshot({ messages: [], threadId: "new-thread", model: chat.model });
    const fresh = hook.render().sendMessage("second");
    requests[0].handlers.onToken("late");
    requests[0].handlers.onDone({ thread_id: "old-thread" });
    requests[0].resolve();
    await old;
    chat = hook.render();
    assert.equal(chat.loading, true);
    assert.equal(chat.threadId, "new-thread");
    requests[1].handlers.onToken("new answer");
    requests[1].handlers.onDone({ thread_id: "new-thread" });
    requests[1].resolve();
    await fresh;
    chat = hook.render();
    assert.equal(chat.loading, false);
    assert.equal(chat.messages.at(-1).content, "new answer");
    assert.equal(chat.messages.at(-1).status, "complete");
  } finally {
    hook.close();
  }
});

test("unmount aborts its request and late settlement cannot update state", async () => {
  const requests = controlledRequests();
  const hook = hookHarness(() => HookModule.default());
  const request = hook.render().sendMessage("hello");
  hook.close();
  const before = hook.updates;
  assert.equal(requests[0].signal.aborted, true);
  requests[0].handlers.onToken("late");
  requests[0].handlers.onDone({ thread_id: "late-thread" });
  requests[0].resolve();
  await request;
  assert.equal(hook.updates, before);
});

test("cancel before first token and restoring interrupted snapshots clear pending indicators", async () => {
  const requests = controlledRequests();
  const hook = hookHarness(() => HookModule.default());
  try {
    const request = hook.render().sendMessage("hello");
    hook.render().stopGeneration();
    requests[0].resolve();
    await request;
    let chat = hook.render();
    assert.equal(chat.messages.at(-1).status, "cancelled");
    assert.equal(chat.messages.at(-1).content, "");
    assert.equal(chat.loading, false);
    chat.restoreSnapshot({ messages: [{
      id: "saved", role: "assistant", content: "partial", status: "streaming",
    }], threadId: "saved-thread", model: chat.model });
    chat = hook.render();
    assert.equal(chat.messages[0].status, "cancelled");
    assert.equal(chat.messages[0].content, "partial");
  } finally {
    hook.close();
  }
});

test("stream cannot change an explicitly requested conversation ID", async () => {
  globalThis.fetch = async () => new Response(start + done);
  await assert.rejects(api.streamChat({ message: "hi", thread_id: "requested" }, {}), /malformed/);
});

test("delta bursts batch message updates and failures preserve partial text", async () => {
  const requests = controlledRequests();
  const hook = hookHarness(() => HookModule.default());
  try {
    const request = hook.render().sendMessage("hello");
    const before = hook.updates;
    for (let i = 0; i < 100; i++) requests[0].handlers.onToken("x");
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(hook.updates - before, 1);
    requests[0].handlers.onError({ message: "Provider unavailable.", status_code: 503 });
    requests[0].resolve();
    await request;
    const message = hook.render().messages.at(-1);
    assert.equal(message.content, "x".repeat(100));
    assert.equal(message.status, "error");
    assert.equal(message.error, "Provider unavailable.");
    assert.equal(message.errorStatus, 503);
    assert.equal(hook.render().loading, false);
  } finally {
    hook.close();
  }
});

test("cancelled and failed partial code blocks retain Markdown rendering", () => {
  for (const status of ["cancelled", "error"]) {
    const html = renderToStaticMarkup(React.createElement(AssistantModule.default, {
      content: "```python\nprint('雪')", status,
      error: status === "error" ? "Provider unavailable." : undefined,
      theme: "dark", assistantName: "Clawbit", onDelete() {}, onRetry() {}, onStop() {},
    }));
    assert.match(html, /language-python/);
    assert.match(html, /雪/);
    assert.match(html, status === "cancelled" ? /Generation stopped/ : /Provider unavailable/);
  }
});
