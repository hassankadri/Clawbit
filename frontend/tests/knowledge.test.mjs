import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import auth from "../lib/auth.ts";
import api from "../lib/api.ts";
import knowledge from "../lib/knowledge.ts";
import MarkdownModule from "../components/chat/Markdown.tsx";
import MemoryModule from "../components/settings/MemoryPanel.tsx";
import HookModule from "../hooks/useChat.ts";
import { hookHarness } from "./hook-harness.mjs";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const documentSource = {
  file: "evidence.pdf", page: 3, kind: "document", source_id: `S${"a".repeat(24)}`,
  thread_id: "thread", attachment_id: "attachment", chunk_id: "2",
};
const webSource = {
  file: "External <report>", kind: "web", source_id: `S${"b".repeat(24)}`,
  url: "https://example.com/report",
};
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  auth.expireSession();
  globalThis.fetch = async () => Response.json({
    user: { username: "fixture", principal_id: "b".repeat(64) },
    csrf_token: "a".repeat(64), expires_at: Date.now() / 1000 + 3600,
  });
  await auth.restoreSession();
});

afterEach(() => {
  auth.expireSession();
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  api.setActiveChatMode("normal");
});

test("citations render beside claims, escape titles, reject invented IDs and leave code intact", () => {
  const content = `Document [${documentSource.source_id}]. Web [${webSource.source_id}]. Again [${webSource.source_id}]. Unknown [Sfake].\n\n\`[${webSource.source_id}]\``;
  const html = renderToStaticMarkup(React.createElement(MarkdownModule.default, {
    content, sources: [documentSource, webSource],
  }));
  assert.match(html, /Open source evidence.pdf, page 3/);
  assert.equal((html.match(/href="https:\/\/example.com\/report"/g) || []).length, 2);
  assert.match(html, /External &lt;report&gt;/);
  assert.match(html, /Unverified source/);
  assert.match(html, new RegExp(`<code[^>]*>\\[${webSource.source_id}\\]</code>`));
  assert.doesNotMatch(html, /<report>/);
  assert.match(renderToStaticMarkup(React.createElement(MarkdownModule.default, { content: "Old answer" })), /Old answer/);
});

test("source URLs reject unsafe schemes, private hosts, credentials and encoded tokens", () => {
  for (const url of [
    "javascript:alert(1)", "file:///private", "http://localhost", "http://0x7f.0.0.1",
    "http://10.0.0.1", "http://100.64.0.1", "http://224.1.2.3", "http://host.lan",
    "https://user:secret@example.com", "https://example.com?%74oken=secret",
  ]) assert.equal(knowledge.sourceUrl({ ...webSource, url }), null, url);
  assert.equal(knowledge.sourceUrl(webSource), webSource.url);
  const html = renderToStaticMarkup(React.createElement(MarkdownModule.default, {
    content: `[${webSource.source_id}]`,
    sources: [{ ...webSource, url: "javascript:alert(1)" }],
  }));
  assert.match(html, /Unverified source/);
  assert.doesNotMatch(html, /href=|<button/);
});

test("source lookup uses authenticated endpoints and surfaces removed-source errors", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ detail: "Source unavailable." }, { status: 404 });
  };
  await assert.rejects(knowledge.loadSource(documentSource), /Source unavailable/);
  await assert.rejects(knowledge.downloadSource(documentSource), /Source unavailable/);
  assert.ok(calls.every(({ url, options }) => url.includes("/sources/thread/attachment") && options.credentials === "include"));
  await assert.rejects(knowledge.loadSource({ file: "legacy.pdf" }), /older source/);
  assert.equal(calls.length, 2);
});

test("memory requests retain explicit confirmation, scope, optimistic versions and CSRF", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ memories: [], id: 4, version: 2 });
  };
  const memory = { id: 4, version: 2, scope: "workspace", workspace_id: "project" };
  await knowledge.listMemories("workspace", "project");
  await knowledge.saveMemory("SQLite preference", "workspace", "project");
  await knowledge.saveMemory("Updated SQLite preference", "workspace", "project", memory);
  await knowledge.deleteMemory(memory);
  assert.ok(calls.every(({ options }) => options.credentials === "include"));
  for (const { options } of calls.slice(1)) assert.ok(new Headers(options.headers).get("X-CSRF-Token"));
  assert.equal(JSON.parse(calls[1].options.body).confirmed, true);
  assert.equal(JSON.parse(calls[2].options.body).version, 2);
  assert.equal(JSON.parse(calls[2].options.body).workspace_id, "project");
  assert.match(calls[3].url, /version=2$/);
  globalThis.fetch = async () => Response.json({ detail: "Memory changed. Reload before updating it." }, { status: 409 });
  await assert.rejects(knowledge.saveMemory("stale", "workspace", "project", memory), /Reload/);
});

test("research selection and progressive source frames reach the real stream parser", async () => {
  api.setActiveChatMode("research");
  const events = [];
  globalThis.fetch = async (_, options) => {
    assert.equal(JSON.parse(options.body).mode, "research");
    return new Response(frame("start", { thread_id: "thread" })
      + frame("sources", { sources: [documentSource, webSource] })
      + frame("token", { text: `Claim [${documentSource.source_id}]` })
      + frame("done", { thread_id: "thread", inspector: { sources: [documentSource] } }));
  };
  await api.streamChat({ message: "Research", thread_id: "thread" }, {
    onSources: (sources) => events.push(sources),
    onToken: (text) => events.push(text),
    onDone: (data) => events.push(data.inspector.sources),
  });
  assert.deepEqual(events, [[documentSource, webSource], `Claim [${documentSource.source_id}]`, [documentSource]]);
});

for (const invalid of [
  { ...documentSource, page: -1 }, { ...documentSource, file: {} },
  { ...documentSource, url: {} }, { ...documentSource, source_id: "forged" },
]) {
  test(`malformed source frame rejects: ${JSON.stringify(invalid)}`, async () => {
    globalThis.fetch = async () => new Response(frame("start", { thread_id: "thread" })
      + frame("sources", { sources: [invalid] }) + frame("done", { thread_id: "thread" }));
    await assert.rejects(api.streamChat({ message: "hi" }, {}), /malformed/);
  });
}

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

test("memory panel requires explicit save and deletion confirmation", async () => {
  const writes = [];
  globalThis.window = { confirm: () => false };
  const memory = { id: 4, content: "SQLite preference", scope: "workspace", workspace_id: "project", version: 0 };
  globalThis.fetch = async (_, options) => {
    if (options.method !== "GET") writes.push(options);
    return Response.json({ memories: [memory] });
  };
  const hook = hookHarness(() => MemoryModule.default({ workspaceId: "project" }));
  try {
    hook.render().props.onOpenChange(true);
    hook.render();
    await tick();
    let tree = hook.render();
    assert.equal(writes.length, 0);
    elements(tree, (node) => node.type === "textarea")[0].props.onChange({ target: { value: "Explicit preference" } });
    tree = hook.render();
    elements(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
    await tick();
    tree = hook.render();
    await tick();
    const remove = elements(hook.render(), (node) => node.type === "button" && node.props.children === "Delete")[0];
    remove.props.onClick();
    assert.equal(writes.length, 1);
    globalThis.window.confirm = () => true;
    remove.props.onClick();
    await tick();
    assert.equal(writes.length, 2);
    assert.equal(JSON.parse(writes[0].body).confirmed, true);
    assert.equal(writes[1].method, "DELETE");
  } finally {
    hook.close();
  }
});

test("restored research mode and citation frames survive the chat hook and snapshot", async () => {
  const originalStream = api.streamChat;
  let callbacks;
  let finish;
  api.streamChat = (body, handlers) => {
    assert.equal(api.getActiveChatMode(), "research");
    callbacks = handlers;
    return new Promise((resolve) => { finish = resolve; });
  };
  const hook = hookHarness(() => HookModule.default());
  try {
    hook.render().restoreSnapshot({
      threadId: "thread", model: "gemini-3.1-flash-lite", mode: "research", messages: [],
    });
    const pending = hook.render().sendMessage("Research a claim");
    await tick();
    callbacks.onSources([documentSource, webSource]);
    assert.deepEqual(hook.render().messages.at(-1).sources, [documentSource, webSource]);
    callbacks.onToken(`Claim [${documentSource.source_id}]`);
    const report = { retrieved_sources: 2, cited_sources: 1, limitations: [] };
    callbacks.onDone({ thread_id: "thread", inspector: { sources: [documentSource], research: report } });
    finish();
    await pending;
    const snapshot = hook.render().createSnapshot();
    assert.equal(snapshot.mode, "research");
    assert.deepEqual(snapshot.messages.at(-1).sources, [documentSource]);
    assert.deepEqual(snapshot.messages.at(-1).research, report);
    hook.render().restoreSnapshot(snapshot);
    assert.deepEqual(hook.render().messages.at(-1).sources, [documentSource]);
  } finally {
    hook.close();
    api.streamChat = originalStream;
  }
});
