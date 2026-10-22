"use client";

import { useState, type FormEvent } from "react";

interface LoginFormProps {
  onSignIn: (username: string, password: string) => Promise<void>;
}

export default function LoginForm({ onSignIn }: LoginFormProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError("");
    try {
      await onSignIn(
        String(fields.get("username") ?? ""),
        String(fields.get("password") ?? ""),
      );
      form.reset();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5 text-foreground">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-7 shadow-sm"
      >
        <div>
          <p className="mb-2 text-sm text-[color:var(--muted-foreground)]">Clawbit AI</p>
          <h1 className="text-2xl font-semibold">Sign in to your workspace</h1>
        </div>
        <div className="space-y-2">
          <label htmlFor="owner-username" className="block text-sm font-medium">
            Username
          </label>
          <input
            id="owner-username"
            name="username"
            autoComplete="username"
            required
            maxLength={64}
            disabled={busy}
            className="w-full rounded-lg border border-[color:var(--border)] bg-transparent px-3 py-2.5 outline-offset-2"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="owner-password" className="block text-sm font-medium">
            Passphrase
          </label>
          <input
            id="owner-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            disabled={busy}
            className="w-full rounded-lg border border-[color:var(--border)] bg-transparent px-3 py-2.5 outline-offset-2"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-xs leading-relaxed text-[color:var(--muted-foreground)]">
          New installation? Initialize the local owner using the setup instructions in the backend README.
        </p>
      </form>
    </main>
  );
}
