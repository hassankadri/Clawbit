"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import LoginForm from "@/components/auth/LoginForm";
import BrowserOwnerGate from "@/components/auth/BrowserOwnerGate";
import {
  expireSession,
  getAuthState,
  getServerAuthState,
  restoreSession,
  signIn,
  subscribeAuth,
} from "@/lib/auth";

export function useAuth() {
  return useSyncExternalStore(subscribeAuth, getAuthState, getServerAuthState);
}

export default function AuthProvider({ children }: { children: ReactNode }) {
  const session = useAuth();

  useEffect(() => {
    void restoreSession();
    const onFocus = () => {
      void restoreSession();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (session.status !== "authenticated" || !session.expiresAt) return;
    const timer = window.setTimeout(
      expireSession, Math.max(0, session.expiresAt * 1000 - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [session.status, session.expiresAt]);

  if (session.status === "loading") {
    return (
      <main className="grid min-h-dvh place-items-center">
        <p role="status">Opening Clawbit…</p>
      </main>
    );
  }
  if (session.status === "unavailable") {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <div className="space-y-4 text-center">
          <p role="alert">Could not reach Clawbit. Check that the backend is running.</p>
          <button
            className="rounded-lg border px-4 py-2"
            onClick={() => void restoreSession()}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (session.status === "anonymous") return <LoginForm onSignIn={signIn} />;
  if (!session.user) return null;
  return (
    <BrowserOwnerGate key={session.user.principal_id} principalId={session.user.principal_id}>
      {children}
    </BrowserOwnerGate>
  );
}
