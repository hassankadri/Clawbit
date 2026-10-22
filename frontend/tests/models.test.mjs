import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import modelsModule from "../lib/models.ts";
import ChoicesModule from "../components/layout/ModelChoices.tsx";
import api from "../lib/api.ts";
import settings from "../lib/settings.ts";
import auth from "../lib/auth.ts";

beforeEach(async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    user: { username: "offline-owner", principal_id: "b".repeat(64) },
    csrf_token: "a".repeat(64),
    expires_at: Date.now() / 1000 + 3600,
  });
  try {
    await auth.restoreSession();
  } finally {
    globalThis.fetch = original;
  }
});

const { MODELS, DEFAULT_MODEL_ID, mergeModelCatalog, confirmModelSelection, getModelConsent, imageSelectionError } = modelsModule;
const ModelChoices = ChoicesModule.default;
const NEW = "nvidia/nemotron-3.5-super-vl:free";
const catalog = MODELS.map((item) => ({ ...item, available: true, reason: "Offline verified fixture",
  capabilities: { ...item.capabilities, tools: true, streaming: true, vision: item.id === NEW },
}));

function browser(approve = true) {
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) };
  globalThis.window = { sessionStorage: storage, localStorage: storage, confirm: () => approve,
    location: { hostname: "localhost" }, dispatchEvent: () => {} };
  return stored;
}

test("all 13 approved IDs are unique and disabled until the server verifies them", () => {
  assert.equal(MODELS.length, 13);
  assert.equal(new Set(MODELS.map((m) => m.id)).size, 13);
  assert.equal(DEFAULT_MODEL_ID, "gemini-3.1-flash-lite");
  assert.ok(MODELS.every((m) => !m.available));
  assert.ok(MODELS.some((m) => m.id === "openai/gpt-oss-120b"));
  assert.ok(MODELS.some((m) => m.id === "qwen/qwen3.8-27b"));
});

test("server availability, missing credentials and provider groups are rendered", () => {
  const data = mergeModelCatalog(catalog.map((m) => m.provider === "groq"
    ? { ...m, available: false, reason: "Missing GROQ_API_KEY. Configure it on the server." } : m));
  const html = renderToStaticMarkup(React.createElement(ModelChoices, { models: data, selected: DEFAULT_MODEL_ID, onSelect() {} }));
  for (const label of ["Google", "Groq", "OpenRouter", "Missing GROQ_API_KEY", "Gemini 3.8 Flash", "North Mini Code"]) assert.ok(html.includes(label));
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
});

test("catalog does not enable unknown or mismatched provider IDs", () => {
  const data = mergeModelCatalog([{ ...catalog[0], provider: "openrouter" }, { ...catalog[0], id: "paid/model" }]);
  assert.ok(data.every((item) => !item.available));
});

test("selection requires consent and preserves the exact selected model ID", () => {
  browser(false);
  const model = catalog.find((m) => m.id === NEW);
  assert.equal(confirmModelSelection(model), false);
  assert.equal(getModelConsent(NEW), undefined);
  window.confirm = () => true;
  assert.equal(confirmModelSelection(model), true);
  assert.equal(getModelConsent(NEW), NEW);
  assert.equal(getModelConsent("cohere/north-mini-code:free"), undefined);
  assert.equal(confirmModelSelection({ ...model, available: false }), false);
});

test("dropdown click calls the existing onSelect handler with the model ID", () => {
  browser();
  const selected = [];
  const tree = ModelChoices({ models: catalog, selected: DEFAULT_MODEL_ID, onSelect: (id) => selected.push(id) });
  const elements = (node) => Array.isArray(node) ? node.flatMap(elements)
    : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
  const button = elements(tree).find((el) => el.type === "button" && el.key === NEW);
  button.props.onClick();
  assert.deepEqual(selected, [NEW]);
});

test("image uploads require a verified vision model; documents remain usable", () => {
  const image = { name: "picture.png", type: "" };
  assert.match(imageSelectionError(catalog[0], image), /vision-capable/);
  assert.equal(imageSelectionError(catalog.find((m) => m.id === NEW), image), null);
  assert.equal(imageSelectionError(catalog[0], { name: "report.pdf", type: "application/pdf" }), null);
});

test("saved default IDs survive availability changes without granting consent", () => {
  browser();
  settings.writeAppSettings({ ...settings.DEFAULT_APP_SETTINGS, defaultModel: NEW });
  assert.equal(settings.readAppSettings().defaultModel, NEW);
  assert.equal(getModelConsent(NEW), undefined);
});

test("chat and SSE transmit exact IDs and consent, without duplicate answer text", async () => {
  browser();
  confirmModelSelection(catalog.find((m) => m.id === NEW));
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return String(url).endsWith("/stream")
      ? new Response('event: start\ndata: {"thread_id":"thread"}\n\nevent: token\ndata: {"text":"hello"}\n\nevent: done\ndata: {"thread_id":"thread"}\n\n', { headers: { "Content-Type": "text/event-stream" } })
      : Response.json({ response: "hello", thread_id: "thread" });
  };
  try {
    assert.equal((await api.chat({ message: "hi", model: NEW })).response, "hello");
    const text = []; let done = 0;
    await api.streamChat({ message: "hi", model: NEW }, { onToken: (token) => text.push(token), onDone: () => done++ });
    assert.deepEqual(text, ["hello"]); assert.equal(done, 1);
    assert.ok(bodies.every((body) => body.model === NEW && body.provider_consent === NEW));
  } finally { globalThis.fetch = original; }
});

test("missing key and quota failures preserve the backend's safe error", async () => {
  browser();
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ detail: "Free quota exhausted; wait before retrying." }, { status: 429 });
  try {
    await assert.rejects(api.streamChat({ message: "hi", model: NEW }, {}), /Free quota exhausted/);
    await assert.rejects(api.chat({ message: "hi", model: NEW }), /Free quota exhausted/);
  } finally { globalThis.fetch = original; }
});

test("endpoint outages keep all 13 models visible and disable only the affected model", async () => {
  const superId = "nvidia/nemotron-3-super-120b-a12b:free";
  const original = globalThis.fetch;
  const reason = "This OpenRouter model has no operational zero-cost tool endpoint.";
  globalThis.fetch = async () => Response.json({
    models: catalog.map((model) => model.id === superId
      ? { ...model, available: false, reason }
      : model),
  });
  try {
    const entries = mergeModelCatalog(await api.fetchModels());
    assert.equal(entries.length, 13);
    assert.equal(entries.find((model) => model.id === superId).available, false);
    assert.ok(entries.filter((model) => model.id !== superId).every((model) => model.available));
    const html = renderToStaticMarkup(React.createElement(ModelChoices, {
      models: entries, selected: superId, onSelect() {},
    }));
    assert.ok(html.includes(reason));
    assert.equal((html.match(/disabled=""/g) ?? []).length, 1);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Nemotron 3 Super keeps its exact free ID, consent and authenticated SSE request", async () => {
  browser();
  const superId = "nvidia/nemotron-3-super-120b-a12b:free";
  assert.equal(confirmModelSelection(catalog.find((model) => model.id === superId)), true);
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response('event: start\ndata: {"thread_id":"existing-thread"}\n\nevent: token\ndata: {"text":"hello"}\n\nevent: done\ndata: {"thread_id":"existing-thread"}\n\n');
  };
  try {
    const tokens = [];
    await api.streamChat({
      message: "hello", model: superId, thread_id: "existing-thread",
    }, { onToken: (text) => tokens.push(text) });
    assert.deepEqual(tokens, ["hello"]);
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].options.body);
    assert.equal(payload.model, superId);
    assert.equal(payload.provider_consent, superId);
    assert.equal(payload.thread_id, "existing-thread");
    assert.equal(requests[0].options.credentials, "include");
    assert.equal(requests[0].options.headers.get("X-CSRF-Token"), "a".repeat(64));
  } finally {
    globalThis.fetch = original;
  }
});
