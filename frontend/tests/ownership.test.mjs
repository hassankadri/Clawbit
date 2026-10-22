import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import browserOwner from "../lib/browser-owner.ts";
import auth from "../lib/auth.ts";
import React from "react";
import GateModule from "../components/auth/BrowserOwnerGate.tsx";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

afterEach(() => {
  auth.expireSession();
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});

test("claim preserves browser data and refuses reassignment in both directions", () => {
  for (const [owner, other] of [["alice", "bob"], ["bob", "alice"]]) {
    const saved = new Map([["clawbit-conversations", "private legacy conversation"]]);
    globalThis.window = { localStorage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    } };
    assert.equal(browserOwner.browserOwnership(owner), "unclaimed");
    browserOwner.claimBrowserProfile(owner);
    assert.equal(browserOwner.browserOwnership(owner), "owned");
    assert.equal(browserOwner.browserOwnership(other), "foreign");
    assert.throws(() => browserOwner.claimBrowserProfile(other), /cannot be reassigned/);
    assert.equal(saved.get("clawbit-conversations"), "private legacy conversation");
  }
});

test("unavailable browser storage fails closed", () => {
  globalThis.window = { get localStorage() { throw new Error("disabled"); } };
  assert.equal(browserOwner.browserOwnership("alice"), "unavailable");
  assert.throws(() => browserOwner.claimBrowserProfile("alice"));
});

test("private children mount only for the claimed browser principal", () => {
  const originalStore = React.useSyncExternalStore;
  const originalState = React.useState;
  React.useSyncExternalStore = (_, snapshot) => snapshot();
  React.useState = (initial) => [initial, () => {}];
  const saved = new Map();
  globalThis.window = { localStorage: {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  } };
  try {
    const render = (principalId) => GateModule.default({ principalId, children: "private content" });
    assert.notEqual(render("alice"), "private content");
    browserOwner.claimBrowserProfile("alice");
    assert.equal(render("alice"), "private content");
    assert.notEqual(render("bob"), "private content");
  } finally {
    React.useSyncExternalStore = originalStore;
    React.useState = originalState;
  }
});

test("changing verified principal aborts prior requests", async () => {
  let principal = "a".repeat(64);
  globalThis.fetch = async () => Response.json({
    user: { username: "test-owner", principal_id: principal },
    csrf_token: "c".repeat(64), expires_at: Date.now() / 1000 + 300,
  });
  await auth.restoreSession();
  let signal;
  const sessionFetch = globalThis.fetch;
  globalThis.fetch = async (_, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start() {} }));
  };
  const response = await auth.authenticatedFetch(`${auth.API_URL}/chat/stream`);
  assert.equal(signal.aborted, false);
  principal = "b".repeat(64);
  globalThis.fetch = sessionFetch;
  await auth.restoreSession();
  assert.equal(signal.aborted, true);
  assert.equal(auth.getAuthState().user.principal_id, principal);
  await response.body.cancel();
});

test("a session without verified principal metadata stays gated", async () => {
  globalThis.fetch = async () => Response.json({
    user: { username: "old-response" }, csrf_token: "c".repeat(64), expires_at: 9999999999,
  });
  await auth.restoreSession();
  assert.equal(auth.getAuthState().status, "unavailable");
});
