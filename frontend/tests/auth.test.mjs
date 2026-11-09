
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import auth from "../lib/auth.ts";
import api from "../lib/api.ts";
import LoginModule from "../components/auth/LoginForm.tsx";
import GateModule from "../components/auth/AuthProvider.tsx";
import BrowserGateModule from "../components/auth/BrowserOwnerGate.tsx";

const LoginForm = LoginModule.default;
const AuthProvider = GateModule.default;

const originalFetch = globalThis.fetch;
const originalFormData = globalThis.FormData;
const originalXHR = globalThis.XMLHttpRequest;

const session = {
  user: {
    username: "offline-owner",
    principal_id: "b".repeat(64),
    email: "owner@example.com",
    role: "admin",
  },
  csrf_token: "a".repeat(64),
  expires_at: Date.now() / 1000 + 3600,
  setup_required: false,
};

beforeEach(() => {
  auth.expireSession();
  globalThis.fetch = async () => {
    throw new Error("Unexpected network request");
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.FormData = originalFormData;
  globalThis.XMLHttpRequest = originalXHR;
});

async function authenticated() {
  globalThis.fetch = async () => Response.json(session);
  await auth.restoreSession();
  assert.equal(auth.getAuthState().status, "authenticated");
}

test("refresh restores shared state without storing session credentials in JavaScript", async () => {
  const calls = [];
  let changes = 0;
  const unsubscribe = auth.subscribeAuth(() => changes++);

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json(session);
  };

  await auth.restoreSession();

  assert.equal(auth.getAuthState().user.username, session.user.username);
  assert.equal(auth.getAuthState().user.role, "admin");
  assert.equal(changes, 1);
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal("token" in auth.getAuthState(), false);

  unsubscribe();
});

test("login obtains a pre-session and submits a separate CSRF token", async () => {
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json(
      url.endsWith("/session")
        ? { ...session, user: null }
        : session,
    );
  };

  await auth.signIn("owner@example.com", "offline passphrase");

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/auth\/session$/);
  assert.equal(
    calls[1].options.headers["X-CSRF-Token"],
    session.csrf_token,
  );

  assert.deepEqual(JSON.parse(calls[1].options.body), {
    username: "owner@example.com",
    password: "offline passphrase",
  });

  assert.equal(auth.getAuthState().status, "authenticated");
});

test("public registration sends email and password with the pre-session CSRF token", async () => {
  const calls = [];
  const anonymous = {
    ...session,
    user: null,
    csrf_token: "c".repeat(64),
    setup_required: false,
  };

  const registeredSession = {
    ...session,
    user: {
      username: "member@example.com",
      email: "member@example.com",
      role: "user",
      principal_id: "d".repeat(64),
    },
  };

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json(
      url.endsWith("/session") ? anonymous : registeredSession,
    );
  };

  await auth.signUp(
    "member@example.com",
    "a sufficiently long offline passphrase",
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/auth\/session$/);
  assert.match(calls[1].url, /\/auth\/register$/);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(
    calls[1].options.headers["X-CSRF-Token"],
    anonymous.csrf_token,
  );

  assert.deepEqual(JSON.parse(calls[1].options.body), {
    email: "member@example.com",
    password: "a sufficiently long offline passphrase",
  });

  assert.equal(auth.getAuthState().status, "authenticated");
  assert.equal(auth.getAuthState().user.role, "user");
});

test("registration is blocked until the administrator is initialized", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      ...session,
      user: null,
      setup_required: true,
    });
  };

  await assert.rejects(
    auth.signUp(
      "member@example.com",
      "a sufficiently long offline passphrase",
    ),
    /administrator setup is required/i,
  );

  assert.equal(calls, 1);
});

test("invalid login remains gated and reports a safe error", async () => {
  globalThis.fetch = async (url) => url.endsWith("/session")
    ? Response.json({ ...session, user: null })
    : Response.json(
        { detail: "provider secret should never be shown" },
        { status: 401 },
      );

  await assert.rejects(
    auth.signIn("owner@example.com", "wrong"),
    /Check your username and passphrase/,
  );

  assert.equal(auth.getAuthState().status, "anonymous");
});

test("logout invalidates local state only after backend acknowledgement", async () => {
  await authenticated();

  globalThis.fetch = async () => {
    throw new Error("offline");
  };

  await assert.rejects(auth.signOut(), /offline/);
  assert.equal(auth.getAuthState().status, "authenticated");

  globalThis.fetch = async (url, options) => {
    assert.match(url, /\/auth\/logout$/);
    assert.equal(options.credentials, "include");
    assert.equal(
      options.headers["X-CSRF-Token"],
      session.csrf_token,
    );
    return Response.json({ success: true });
  };

  await auth.signOut();

  assert.equal(auth.getAuthState().status, "anonymous");
  assert.throws(auth.authenticatedHeaders, /Sign in/);
});

test("a delayed restoration cannot undo logout or expiry", async () => {
  let respond;

  globalThis.fetch = () => new Promise((resolve) => {
    respond = resolve;
  });

  const restoring = auth.restoreSession();
  auth.expireSession();

  respond(Response.json(session));
  await restoring;

  assert.equal(auth.getAuthState().status, "anonymous");
});

test("401 gates the application and prevents repeated background requests", async () => {
  await authenticated();

  let calls = 0;

  globalThis.fetch = async () => {
    calls++;
    return Response.json(
      { detail: "Sign in to continue." },
      { status: 401 },
    );
  };

  await assert.rejects(api.fetchModels(), /Could not verify/);
  assert.equal(auth.getAuthState().status, "anonymous");

  await assert.rejects(api.fetchModels(), /Sign in/);
  assert.equal(calls, 1);
});

test("protected fetches cannot send credentials to another origin", async () => {
  await authenticated();

  globalThis.fetch = async () => {
    assert.fail("No request should be sent");
  };

  await assert.rejects(
    auth.authenticatedFetch("https://attacker.example/collect"),
    /configured/,
  );

  await assert.rejects(
    auth.authenticatedFetch(
      `${auth.API_URL}.attacker.example/collect`,
    ),
    /configured/,
  );
});

test("model, chat, SSE and connector helpers preserve credentials and CSRF", async () => {
  await authenticated();

  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });

    if (url.endsWith("/models")) {
      return Response.json({ models: [] });
    }

    if (url.endsWith("/stream")) {
      return new Response(
        'event: token\ndata: {"text":"hello"}\n\n' +
        'event: done\ndata: {"thread_id":"old-thread"}\n\n',
      );
    }

    return Response.json({
      response: "hello",
      authorization_url: "https://example.com",
    });
  };

  await api.fetchModels();

  await api.chat({
    message: "hi",
    model: "gemini-3.1-flash-lite",
  });

  const tokens = [];

  await api.streamChat(
    {
      message: "hi",
      model: "gemini-3.1-flash-lite",
    },
    {
      onToken: (text) => tokens.push(text),
    },
  );

  await api.connectGoogleDriveMCP();
  await api.connectSlackMCP();

  assert.deepEqual(tokens, ["hello"]);

  for (const { options } of calls) {
    assert.equal(options.credentials, "include");
    assert.equal(
      options.headers.get("X-CSRF-Token"),
      session.csrf_token,
    );
    assert.equal(options.redirect, "error");
  }

  assert.ok(
    calls.slice(-2).every(({ options }) => options.method === "POST"),
  );
});

test("uploads send credentials and CSRF; expired sessions reject further uploads", async () => {
  await authenticated();
  globalThis.fetch = async () => Response.json({ mode: "multipart" });

  const requests = [];

  globalThis.XMLHttpRequest = class {
    upload = {};
    headers = {};
    status = 200;
    responseText = '{"attachment_id":"attachment"}';

    constructor() {
      requests.push(this);
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name, value) {
      this.headers[name] = value;
    }

    send(body) {
      this.body = body;
      this.onload();
      this.onloadend();
    }

    abort() {
      this.onabort?.();
      this.onloadend?.();
    }
  };

  const file = new File(["text"], "file.txt", {
    type: "text/plain",
  });

  await api.uploadAttachment("old-thread", file).promise;

  assert.equal(requests[0].withCredentials, true);
  assert.equal(
    requests[0].headers["X-CSRF-Token"],
    session.csrf_token,
  );
  assert.equal(requests[0].body.get("thread_id"), "old-thread");

  auth.expireSession();

  await assert.rejects(
    api.uploadAttachment("old-thread", file).promise,
    /Sign in/,
  );

  assert.equal(requests[1].body, undefined);
});

test("logout or expiry aborts an SSE request after response headers arrive", async () => {
  await authenticated();

  let signal;

  globalThis.fetch = async (url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start() {},
    }));
  };

  const response = await auth.authenticatedFetch(
    `${auth.API_URL}/chat/stream`,
  );

  assert.equal(signal.aborted, false);
  auth.expireSession();
  assert.equal(signal.aborted, true);

  await response.body.cancel();
});

test("login form exposes separate accessible login and signup tabs", () => {
  const html = renderToStaticMarkup(
    React.createElement(LoginForm, {
      setupRequired: false,
      onSignIn() {},
      onSignUp() {},
    }),
  );

  assert.match(html, /role="tablist"/);
  assert.match(html, /Log in/);
  assert.match(html, /Sign up/);
  assert.match(html, /Email or username/);
  assert.match(html, /Forgot your passphrase\?/);

  const uninitializedHtml = renderToStaticMarkup(
    React.createElement(LoginForm, {
      setupRequired: true,
      onSignIn() {},
      onSignUp() {},
    }),
  );

  assert.match(uninitializedHtml, /administrator must run/);
  assert.match(uninitializedHtml, /Sign up/);
  assert.match(uninitializedHtml, /disabled/);

  const gated = renderToStaticMarkup(
    React.createElement(
      AuthProvider,
      null,
      "private conversations",
    ),
  );

  assert.doesNotMatch(gated, /private conversations/);
});

test("login form submits entered values, shows failure and resets only on success", async () => {
  const originalState = React.useState;
  const updates = [];

  React.useState = (initial) => [
    initial,
    (value) => updates.push(value),
  ];

  globalThis.FormData = class {
    get(name) {
      return name === "identifier"
        ? "owner@example.com"
        : "offline password";
    }
  };

  try {
    let resets = 0;
    let prevented = 0;

    const event = {
      preventDefault() {
        prevented++;
      },
      currentTarget: {
        reset() {
          resets++;
        },
      },
    };

    const renderForm = (onSignIn) => LoginForm({
      setupRequired: false,
      onSignIn,
      onSignUp: async () => {},
    }).props.children.props.children[0];

    await renderForm(async (username, password) => {
      assert.equal(username, "owner@example.com");
      assert.equal(password, "offline password");
      throw new Error("Invalid credentials.");
    }).props.onSubmit(event);

    assert.equal(resets, 0);
    assert.ok(updates.includes("Invalid credentials."));

    await renderForm(async () => {}).props.onSubmit(event);

    assert.equal(resets, 1);
    assert.equal(prevented, 2);
  } finally {
    React.useState = originalState;
  }
});

test("signup form checks matching passphrases and submits the registered email", async () => {
  const originalState = React.useState;
  const updates = [];
  let hook = 0;

  React.useState = (initial) => {
    const current = hook++ === 0 ? "signup" : initial;
    return [current, (value) => updates.push(value)];
  };

  const values = {
    email: "member@example.com",
    password: "a sufficiently long passphrase",
    confirmPassword: "a sufficiently long passphrase",
  };

  globalThis.FormData = class {
    get(name) {
      return values[name];
    }
  };

  try {
    let resets = 0;
    let submitted;

    const event = {
      preventDefault() {},
      currentTarget: {
        reset() {
          resets++;
        },
      },
    };

    const form = LoginForm({
      setupRequired: false,
      onSignIn: async () => {},
      onSignUp: async (...args) => {
        submitted = args;
      },
    }).props.children.props.children[0];

    values.confirmPassword = "a different passphrase";
    await form.props.onSubmit(event);

    assert.equal(submitted, undefined);
    assert.ok(updates.includes("The passphrases do not match."));
    assert.equal(resets, 0);

    values.confirmPassword = values.password;
    await form.props.onSubmit(event);

    assert.deepEqual(submitted, [
      "member@example.com",
      "a sufficiently long passphrase",
    ]);
    assert.equal(resets, 1);
  } finally {
    React.useState = originalState;
  }
});

test("the application gate mounts private views only while authenticated", async () => {
  const originalStore = React.useSyncExternalStore;
  const originalEffect = React.useEffect;

  React.useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();
  React.useEffect = () => {};

  try {
    const anonymousView = AuthProvider({
      children: "private workspace",
    });

    assert.equal(anonymousView.type, LoginForm);
    assert.equal(anonymousView.props.setupRequired, false);

    await authenticated();

    const ownedView = AuthProvider({
      children: "private workspace",
    });

    assert.equal(ownedView.type, BrowserGateModule.default);
    assert.equal(
      ownedView.props.principalId,
      session.user.principal_id,
    );
    assert.equal(
      ownedView.props.children,
      "private workspace",
    );

    auth.expireSession();

    assert.equal(
      AuthProvider({
        children: "private workspace",
      }).type,
      LoginForm,
    );
  } finally {
    React.useSyncExternalStore = originalStore;
    React.useEffect = originalEffect;
  }
});

test("the application gate passes administrator setup status to the auth tabs", async () => {
  const originalStore = React.useSyncExternalStore;
  const originalEffect = React.useEffect;

  React.useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();
  React.useEffect = () => {};

  try {
    globalThis.fetch = async () => Response.json({
      ...session,
      user: null,
      setup_required: true,
    });

    await auth.restoreSession();

    const setupView = AuthProvider({
      children: "private workspace",
    });

    assert.equal(setupView.type, LoginForm);
    assert.equal(setupView.props.setupRequired, true);
    assert.equal(typeof setupView.props.onSignUp, "function");

    const markup = renderToStaticMarkup(
      React.createElement(LoginForm, setupView.props),
    );

    assert.match(markup, /Sign up/);
    assert.match(markup, /administrator must run/);
  } finally {
    React.useSyncExternalStore = originalStore;
    React.useEffect = originalEffect;
  }
});

test("restoration of a revoked session removes private state and cancels requests", async () => {
  await authenticated();

  let aborted = false;
  const unregister = auth.registerUpload(() => {
    aborted = true;
  });

  globalThis.fetch = async () => Response.json({
    ...session,
    user: null,
  });

  await auth.restoreSession();

  assert.equal(auth.getAuthState().status, "anonymous");
  assert.equal(aborted, true);

  unregister();
});

test("a late unauthorized response cannot invalidate a newer session", async () => {
  await authenticated();

  let respond;

  globalThis.fetch = () => new Promise((resolve) => {
    respond = resolve;
  });

  const request = auth.authenticatedFetch(
    `${auth.API_URL}/models`,
  );

  globalThis.fetch = async () => Response.json({
    ...session,
    csrf_token: "b".repeat(64),
  });

  await auth.restoreSession();

  respond(
    Response.json(
      { detail: "Expired old session" },
      { status: 401 },
    ),
  );

  const response = await request;
  await response.text();

  assert.equal(auth.getAuthState().status, "authenticated");
});
