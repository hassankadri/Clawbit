"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { signOut } from "@/lib/auth";

export default function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function logout() {
    setBusy(true);
    setError("");
    try {
      await signOut();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not sign out.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        title="Sign out"
        aria-label="Sign out"
        disabled={busy}
        onClick={logout}
        className="ui-icon-button"
      >
        <LogOut size={16} />
      </button>
      {error && (
        <p
          role="alert"
          className="absolute right-0 top-full z-50 w-64 rounded-lg border bg-background p-3 text-sm"
        >
          {error}
        </p>
      )}
    </div>
  );
}
