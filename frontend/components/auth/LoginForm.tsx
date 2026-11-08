"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type AuthMode = "login" | "signup";

interface TurnstileRenderOptions {
  sitekey: string;
  action: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
}

interface TurnstileAPI {
  render: (element: HTMLElement, options: TurnstileRenderOptions) => string;
  reset?: (widgetId?: string) => void;
  remove?: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileAPI;
  }
}

interface LoginFormProps {
  setupRequired?: boolean;
  onSignIn: (identifier: string, password: string) => Promise<void>;
  onSignUp: (
    email: string,
    password: string,
    turnstileToken?: string,
  ) => Promise<void>;
}

const TURNSTILE_SCRIPT_ID = "clawbit-turnstile-script";
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";


interface TurnstileWidgetProps {
  siteKey: string;
  onToken: (token: string) => void;
  onError: (message: string) => void;
  resetKey: number;
}

function TurnstileWidget({
  siteKey,
  onToken,
  onError,
  resetKey,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let script: HTMLScriptElement | null = null;

    const renderWidget = () => {
      if (
        disposed ||
        !window.turnstile ||
        !containerRef.current ||
        widgetIdRef.current
      ) {
        return;
      }

      try {
        widgetIdRef.current = window.turnstile.render(
          containerRef.current,
          {
            sitekey: siteKey,
            action:
              process.env.NEXT_PUBLIC_TURNSTILE_TEST_MODE === "true"
                ? "test"
                : "signup",
            callback: (token) => {
              if (!disposed) onToken(token);
            },
            "expired-callback": () => {
              if (!disposed) onToken("");
            },
            "error-callback": () => {
              if (!disposed) {
                onToken("");
                onError(
                  "Signup security verification failed. Refresh the page and try again."
                );
              }
            },
          }
        );
      } catch {
        if (!disposed) {
          onError("Could not load signup security verification.");
        }
      }
    };

    const handleLoad = () => renderWidget();
    const handleError = () => {
      if (!disposed) {
        onError("Could not connect to the signup security service.");
      }
    };

    if (window.turnstile) {
      renderWidget();
    } else {
      script = document.getElementById(
        TURNSTILE_SCRIPT_ID
      ) as HTMLScriptElement | null;

      const isNewScript = !script;

      if (!script) {
        script = document.createElement("script");
        script.id = TURNSTILE_SCRIPT_ID;
        script.src = TURNSTILE_SCRIPT_URL;
        script.async = true;
        script.defer = true;
      }

      script.addEventListener("load", handleLoad);
      script.addEventListener("error", handleError);

      if (isNewScript) {
        document.head.appendChild(script);
      }
    }

    return () => {
      disposed = true;

      script?.removeEventListener("load", handleLoad);
      script?.removeEventListener("error", handleError);

      if (widgetIdRef.current) {
        window.turnstile?.remove?.(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, onToken, onError, resetKey]);

  return <div ref={containerRef} className="min-h-[65px]" />;
}

export default function LoginForm({
  setupRequired = false,
  onSignIn,
  onSignUp,
}: LoginFormProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

  const isSignup = mode === "signup";
  const turnstileSiteKey =
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";



  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const form = event.currentTarget;
    const fields = new FormData(form);
    const password = String(fields.get("password") ?? "");

    setBusy(true);
    setError("");

    try {
      if (isSignup) {
        const email = String(fields.get("email") ?? "").trim();
        const confirmation = String(fields.get("confirmPassword") ?? "");

        if (password.length < 15 || new Set(password).size < 8) {
          throw new Error(
            "Use a passphrase with at least 15 characters and 8 different characters.",
          );
        }

        if (password !== confirmation) {
          throw new Error("The passphrases do not match.");
        }

        if (turnstileSiteKey && !turnstileToken) {
          throw new Error("Complete the signup security check first.");
        }

        if (turnstileSiteKey) {
          await onSignUp(email, password, turnstileToken);
        } else {
          // Local development without Turnstile configuration.
          await onSignUp(email, password);
        }
      } else {
        const identifier = String(fields.get("identifier") ?? "").trim();
        await onSignIn(identifier, password);
      }

      form.reset();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : isSignup
            ? "Could not create your account."
            : "Could not sign in.",
      );

      if (isSignup && turnstileSiteKey) {
        setTurnstileToken("");
        setTurnstileResetKey((current) => current + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  function changeMode(next: AuthMode) {
    if (busy || next === mode || (setupRequired && next === "signup")) {
      return;
    }

    setMode(next);
    setError("");
    setTurnstileToken("");
    setShowRecovery(false);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-10 text-foreground">
      <div className="w-full max-w-md space-y-4">
        <form
          onSubmit={submit}
          className="space-y-5 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-7 shadow-sm sm:p-8"
        >
          <div>
            <p className="mb-2 text-sm font-medium text-[color:var(--muted-foreground)]">
              Clawbit AI
            </p>

            <h1 className="text-2xl font-semibold tracking-tight">
              {isSignup ? "Create your account" : "Welcome back"}
            </h1>

            <p className="mt-2 text-sm leading-relaxed text-[color:var(--muted-foreground)]">
              {isSignup
                ? "Create a private account to start using your AI workspace."
                : "Sign in to continue to your private workspace."}
            </p>
          </div>

          <div
            className="grid grid-cols-2 rounded-lg border border-[color:var(--border)] bg-background p-1"
            role="tablist"
            aria-label="Account access"
          >
            <button
              type="button"
              role="tab"
              aria-selected={!isSignup}
              onClick={() => changeMode("login")}
              disabled={busy}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                !isSignup
                  ? "bg-[color:var(--surface)] text-foreground shadow-sm"
                  : "text-[color:var(--muted-foreground)] hover:text-foreground"
              }`}
            >
              Log in
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={isSignup}
              onClick={() => changeMode("signup")}
              disabled={busy || setupRequired}
              title={
                setupRequired
                  ? "Administrator setup is required first"
                  : undefined
              }
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isSignup
                  ? "bg-[color:var(--surface)] text-foreground shadow-sm"
                  : "text-[color:var(--muted-foreground)] hover:text-foreground"
              }`}
            >
              Sign up
            </button>
          </div>

          {setupRequired && (
            <div className="rounded-lg border border-[color:var(--border)] bg-background px-3 py-3 text-sm leading-relaxed text-[color:var(--muted-foreground)]">
              Clawbit has not been initialized yet. The deployment
              administrator must run{" "}
              <code>python setup_owner.py</code> on the backend host before
              public registration is enabled.
            </div>
          )}

          {isSignup ? (
            <div className="space-y-2">
              <label
                htmlFor="signup-email"
                className="block text-sm font-medium"
              >
                Email address
              </label>

              <input
                id="signup-email"
                name="email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={254}
                disabled={busy || setupRequired}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-[color:var(--border)] bg-transparent px-3 py-2.5 outline-offset-2 focus-visible:outline focus-visible:outline-2"
              />
            </div>
          ) : (
            <div className="space-y-2">
              <label
                htmlFor="login-identifier"
                className="block text-sm font-medium"
              >
                Email or username
              </label>

              <input
                id="login-identifier"
                name="identifier"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={254}
                disabled={busy}
                className="w-full rounded-lg border border-[color:var(--border)] bg-transparent px-3 py-2.5 outline-offset-2 focus-visible:outline focus-visible:outline-2"
              />
            </div>
          )}

          <div className="space-y-2">
            <label
              htmlFor="account-password"
              className="block text-sm font-medium"
            >
              Passphrase
            </label>

            <div className="relative">
              <input
                id="account-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete={isSignup ? "new-password" : "current-password"}
                required
                minLength={isSignup ? 15 : undefined}
                maxLength={128}
                disabled={busy || (setupRequired && !isSignup)}
                className="w-full rounded-lg border border-[color:var(--border)] bg-transparent px-3 py-2.5 pr-16 outline-offset-2 focus-visible:outline focus-visible:outline-2"
              />

              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? "Hide passphrase" : "Show passphrase"}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-3 my-auto text-xs font-medium text-[color:var(--muted-foreground)] hover:text-foreground"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {isSignup && (
            <>
              <div className="space-y-2">
                <label
                  htmlFor="confirm-password"
                  className="block text-sm font-medium"
                >
                  Confirm passphrase
                </label>

                <input
                  id="confirm-password"
                  name="confirmPassword"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  minLength={15}
                  maxLength={128}
                  disabled={busy}
                  className="w-full rounded-lg border border-[color:var(--border)] bg-transparent px-3 py-2.5 outline-offset-2 focus-visible:outline focus-visible:outline-2"
                />

                <p className="text-xs leading-relaxed text-[color:var(--muted-foreground)]">
                  Use at least 15 characters and a mix of different characters.
                </p>
              </div>

              {turnstileSiteKey && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    Security verification
                  </p>

                  <TurnstileWidget
                    siteKey={turnstileSiteKey}
                    resetKey={turnstileResetKey}
                    onToken={setTurnstileToken}
                    onError={setError}
                  />

                  <p
                    className="text-xs text-[color:var(--muted-foreground)]"
                    role="status"
                  >
                    Complete this check to protect Clawbit from automated signups.
                  </p>
                </div>
              )}
            </>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || setupRequired}
            className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy
              ? isSignup
                ? "Creating account…"
                : "Signing in…"
              : isSignup
                ? "Create account"
                : "Sign in"}
          </button>

          {!isSignup && (
            <div className="text-center">
              <button
                type="button"
                onClick={() => {
                  setShowRecovery((visible) => !visible);
                  setError("");
                }}
                className="text-sm text-[color:var(--muted-foreground)] underline-offset-4 hover:text-foreground hover:underline"
              >
                {showRecovery
                  ? "Hide recovery instructions"
                  : "Forgot your passphrase?"}
              </button>
            </div>
          )}

          <p className="text-xs leading-relaxed text-[color:var(--muted-foreground)]">
            Each Clawbit account has its own private conversations, files,
            memories and connected services.
          </p>
        </form>

        {showRecovery && !isSignup && (
          <section
            aria-labelledby="password-reset-title"
            className="space-y-3 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6"
          >
            <h2 id="password-reset-title" className="font-semibold">
              Account recovery
            </h2>

            <p className="text-sm leading-relaxed text-[color:var(--muted-foreground)]">
              Self-service email recovery is not configured yet. Contact the
              Clawbit administrator, who can verify your identity and reset
              only your account from the server terminal.
            </p>

            <pre className="overflow-x-auto rounded-lg bg-background p-3 text-xs">
              <code>{".\\.venv\\Scripts\\python.exe reset_user_password.py"}</code>
            </pre>

            <p className="text-xs leading-relaxed text-[color:var(--muted-foreground)]">
              The administrator must run this command on the backend host. It
              revokes only the selected account&apos;s sessions and does not
              delete its data.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
