
export interface AuthSession {
  user: {
    username: string;
    email?: string | null;
    role?: "admin" | "user";
    principal_id: string;
  } | null;
  csrf_token: string;
  expires_at: number | null;
  setup_required: boolean;
}

export interface AuthState {
  status: "loading" | "authenticated" | "anonymous" | "unavailable";
  user: AuthSession["user"];
  expiresAt: number | null;
  setupRequired: boolean;
}

export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? window.location.protocol === "https:"
      ? `${window.location.origin}/api`
      : `http://${window.location.hostname || "127.0.0.1"}:8000`
    : "http://127.0.0.1:8000")
).replace(/\/$/, "");

const initialState: AuthState = {
  status: "loading",
  user: null,
  expiresAt: null,
  setupRequired: false,
};

let state = initialState;
let csrfToken = "";
let revision = 0;
let restoration: Promise<void> | null = null;

const listeners = new Set<() => void>();
const pendingRequests = new Set<AbortController>();
const pendingUploads = new Set<() => void>();

export function getAuthState(): AuthState {
  return state;
}

export function getServerAuthState(): AuthState {
  return initialState;
}

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function publish(next: AuthState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function acceptSession(session: AuthSession) {
  if (
    typeof session.csrf_token !== "string" ||
    !/^[a-f0-9]{64}$/.test(session.csrf_token) ||
    typeof session.setup_required !== "boolean" ||
    (session.user !== null && (
      typeof session.user?.username !== "string" ||
      typeof session.user?.principal_id !== "string" ||
      !/^[a-f0-9]{64}$/.test(session.user.principal_id) ||
      (session.user.email != null && typeof session.user.email !== "string") ||
      (session.user.role != null &&
        !["admin", "user"].includes(session.user.role))
    ))
  ) {
    throw new Error("Invalid session response.");
  }

  if (
    state.status === "authenticated" &&
    (!session.user ||
      session.user.principal_id !== state.user?.principal_id)
  ) {
    expireSession();
  }

  csrfToken = session.csrf_token;

  publish({
    status: session.user ? "authenticated" : "anonymous",
    user: session.user,
    expiresAt: session.expires_at,
    setupRequired: session.setup_required,
  });
}

export function expireSession(): void {
  revision++;
  csrfToken = "";

  pendingRequests.forEach((controller) => controller.abort());
  pendingUploads.forEach((abort) => abort());

  pendingRequests.clear();
  pendingUploads.clear();

  publish({
    status: "anonymous",
    user: null,
    expiresAt: null,
    setupRequired: false,
  });
}

async function sessionRequest(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
  });
}

export function restoreSession(): Promise<void> {
  if (restoration) return restoration;

  const startedAt = revision;

  restoration = (async () => {
    try {
      const response = await sessionRequest("/auth/session");

      if (!response.ok) {
        throw new Error("Could not verify your session.");
      }

      const session = await response.json() as AuthSession;

      if (revision === startedAt) {
        acceptSession(session);
      }
    } catch {
      if (revision === startedAt) {
        publish({
          status: "unavailable",
          user: null,
          expiresAt: null,
          setupRequired: false,
        });
      }
    } finally {
      restoration = null;
    }
  })();

  return restoration;
}

export async function signIn(
  username: string,
  password: string,
): Promise<void> {
  await restoreSession();

  if (!csrfToken || state.status === "unavailable") {
    throw new Error(
      "Could not reach Clawbit. Check that the backend is running.",
    );
  }

  if (state.setupRequired) {
    throw new Error(
      "This installation needs its one-time setup before you can sign in.",
    );
  }

  const response = await sessionRequest("/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 429
        ? "Too many sign-in attempts. Try again in a minute."
        : "Could not sign in. Check your username and passphrase.",
    );
  }

  revision++;
  acceptSession(await response.json() as AuthSession);
}

export async function signUp(
  email: string,
  password: string,
  turnstileToken?: string,
): Promise<void> {
  await restoreSession();

  if (!csrfToken || state.status === "unavailable") {
    throw new Error(
      "Could not reach Clawbit. Check that the backend is running.",
    );
  }

  if (state.status !== "anonymous") {
    throw new Error("Sign out before creating another account.");
  }

  if (state.setupRequired) {
    throw new Error(
      "Clawbit administrator setup is required before public registration is enabled.",
    );
  }

  const registrationPayload: {
    email: string;
    password: string;
    turnstile_token?: string;
  } = {
    email,
    password,
  };

  if (turnstileToken) {
    registrationPayload.turnstile_token = turnstileToken;
  }

  const response = await sessionRequest("/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(registrationPayload),
  });

  if (!response.ok) {
    switch (response.status) {
      case 428:
        throw new Error(
          "Complete the signup security check and try again.",
        );

      case 422:
        throw new Error(
          "Signup security verification failed. Complete the check again.",
        );

      case 429:
        throw new Error(
          "Too many signup attempts. Please try again later.",
        );

      case 503:
        throw new Error(
          "Account registration is temporarily unavailable. Contact the administrator.",
        );

      case 400:
        throw new Error(
          "Unable to create an account with those details. Check your email and passphrase, or try signing in.",
        );

      case 403:
        throw new Error(
          "Your signup session expired. Refresh the page and try again.",
        );

      default:
        throw new Error(
          "Could not create your account. Please try again.",
        );
    }
  }

  revision++;
  acceptSession(await response.json() as AuthSession);
}

export async function signOut(): Promise<void> {
  const response = await sessionRequest("/auth/logout", {
    method: "POST",
    headers: {
      "X-CSRF-Token": csrfToken,
    },
  });

  if (!response.ok && response.status !== 401) {
    throw new Error(
      "Could not sign out. Check your connection and try again.",
    );
  }

  expireSession();

  try {
    const previews = await import("./chatAttachmentPreviews");
    await previews.purgeAllChatAttachmentPreviews();
  } catch {
    // Remain signed out when browser storage is unavailable.
  }
}

export function authenticatedHeaders(): Record<string, string> {
  if (state.status !== "authenticated" || !csrfToken) {
    throw new Error("Sign in to continue.");
  }

  return {
    "X-CSRF-Token": csrfToken,
  };
}

export function handleAuthStatus(
  status: number,
  requestCsrfToken: string,
): void {
  if (status === 401 && requestCsrfToken === csrfToken) {
    expireSession();
  }
}

export function registerUpload(abort: () => void): () => void {
  pendingUploads.add(abort);

  return () => {
    pendingUploads.delete(abort);
  };
}

export async function authenticatedFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  if (!url.startsWith(`${API_URL}/`)) {
    throw new Error(
      "Authenticated requests must target the configured Clawbit API.",
    );
  }

  const headers = new Headers(options.headers);

  for (const [name, value] of Object.entries(authenticatedHeaders())) {
    headers.set(name, value);
  }

  const controller = new AbortController();

  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  pendingRequests.add(controller);

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal,
    });

    handleAuthStatus(
      response.status,
      headers.get("X-CSRF-Token") ?? "",
    );

    if (!response.ok || !response.body) {
      pendingRequests.delete(controller);
      return response;
    }

    const reader = response.body.getReader();

    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const { done, value } = await reader.read();

          if (done) {
            pendingRequests.delete(controller);
            stream.close();
          } else {
            stream.enqueue(value);
          }
        } catch (error) {
          pendingRequests.delete(controller);
          stream.error(error);
        }
      },

      async cancel(reason) {
        pendingRequests.delete(controller);
        controller.abort(reason);

        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    pendingRequests.delete(controller);
    throw error;
  }
}
