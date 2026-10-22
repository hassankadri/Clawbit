"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { browserOwnership, claimBrowserProfile } from "@/lib/browser-owner";
import { signOut } from "@/lib/auth";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("clawbit-browser-owner", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("clawbit-browser-owner", listener);
  };
}

export default function BrowserOwnerGate({ principalId, children }: {
  principalId: string;
  children: ReactNode;
}) {
  const [error, setError] = useState("");
  const status = useSyncExternalStore(
    subscribe, () => browserOwnership(principalId), () => "unavailable",
  );
  if (status === "owned") return children;

  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="max-w-md space-y-4 text-center">
        <p role="status">
          {status === "unclaimed"
            ? "Use this browser’s existing conversations, projects, files and preferences with your signed-in account? They will stay in this browser profile."
            : status === "foreign"
              ? "This browser profile belongs to another account. Use a separate browser profile to protect its local data."
              : "Browser storage is unavailable. Enable it and reload to access your local data."}
        </p>
        {error && <p role="alert">{error}</p>}
        {status === "unclaimed" && (
          <button className="rounded-lg border px-4 py-2" onClick={() => {
            try {
              claimBrowserProfile(principalId);
              window.dispatchEvent(new Event("clawbit-browser-owner"));
            } catch {
              setError("Could not claim this browser profile. Reload and try again.");
            }
          }}>
            Use this browser profile
          </button>
        )}
        <button className="rounded-lg border px-4 py-2" onClick={() => {
          void signOut().catch(() => setError("Could not sign out. Check your connection."));
        }}>
          Sign out
        </button>
      </div>
    </main>
  );
}
