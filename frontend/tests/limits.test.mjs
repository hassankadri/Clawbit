import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import api from "../lib/api.ts";
import auth from "../lib/auth.ts";

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  auth.expireSession();
  globalThis.fetch = async () => Response.json({
    user: { username: "offline-owner", principal_id: "b".repeat(64) },
    csrf_token: "a".repeat(64),
    expires_at: Date.now() / 1000 + 3600,
  });
  await auth.restoreSession();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("HTTP rate errors include retry guidance without automatic retries", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ detail: "Too many requests." }, {
      status: 429, headers: { "Retry-After": "17" },
    });
  };
  await assert.rejects(api.chat({ message: "hello" }), /Too many requests\. Try again in 17 seconds/);
  assert.equal(calls, 1);
  assert.equal(auth.getAuthState().status, "authenticated");
});

test("local quota guidance is displayed only once", async () => {
  globalThis.fetch = async () => Response.json({
    detail: "The local daily usage quota has been reached. Try again in 300 seconds.",
  }, { status: 429, headers: { "Retry-After": "300" } });
  await assert.rejects(api.streamChat({ message: "hello" }, {}), (error) => {
    assert.equal(error.message.match(/Try again/g).length, 1);
    assert.match(error.message, /daily usage quota/);
    return true;
  });
});

test("SSE quota error preserves metadata and delivers one error callback", async () => {
  globalThis.fetch = async () => new Response(
    'event: start\ndata: {"thread_id":"one"}\n\n'
    + 'event: error\ndata: {"message":"Local quota reached.","status_code":429,"retry_after":42}\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  );
  const errors = [];
  await api.streamChat({ message: "hello" }, { onError: (error) => errors.push(error) });
  assert.deepEqual(errors, [{
    message: "Local quota reached. Try again in 42 seconds.",
    status_code: 429, retry_after: 42,
  }]);
});

test("disconnected connector errors preserve the safe backend message", async () => {
  globalThis.fetch = async () => Response.json({
    detail: "Connector unavailable or credentials expired. Reconnect and try again.",
  }, { status: 400 });
  await assert.rejects(api.connectGitHubMCP("offline-token"), /credentials expired\. Reconnect/);
});
