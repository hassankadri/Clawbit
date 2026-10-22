/** Bind this browser profile without moving or deleting its existing data. */
const OWNER_KEY = "clawbit-browser-owner-v1";

export type BrowserOwnership = "unclaimed" | "owned" | "foreign" | "unavailable";

export function browserOwnership(principalId: string): BrowserOwnership {
  try {
    const owner = window.localStorage.getItem(OWNER_KEY);
    if (!owner) return "unclaimed";
    return owner === principalId ? "owned" : "foreign";
  } catch {
    return "unavailable";
  }
}

export function claimBrowserProfile(principalId: string): void {
  if (browserOwnership(principalId) !== "unclaimed") {
    throw new Error("This browser profile cannot be reassigned.");
  }
  window.localStorage.setItem(OWNER_KEY, principalId);
}
