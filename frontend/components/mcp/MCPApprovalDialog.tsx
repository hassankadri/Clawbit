
"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import {
  API_URL,
  authenticatedFetch,
} from "@/lib/auth";

interface PendingApproval {
  id: string;
  provider: string;
  tool: string;
  arguments: string;
  expires_in: number;
}

interface ApprovalResponse {
  pending: PendingApproval[];
}

const PROVIDERS: Record<string, string> = {
  github: "GitHub",
  notion: "Notion",
  stripe: "Stripe",
  "google-drive": "Google Drive",
  slack: "Slack",
  local: "Local MCP",
};

export default function MCPApprovalDialog() {
  const [pending, setPending] =
    useState<PendingApproval[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let checking = false;
    const controller = new AbortController();

    async function refresh() {
      if (!active || checking) return;

      checking = true;

      try {
        const response = await authenticatedFetch(
          `${API_URL}/mcp/approvals`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          throw new Error("Unable to check pending approvals.");
        }

        const data =
          (await response.json()) as ApprovalResponse;

        if (
          active &&
          Array.isArray(data.pending)
        ) {
          setPending(data.pending);
        }
      } catch {
        // Temporary network failures must never grant approval.
        // The backend automatically denies expired requests.
      } finally {
        checking = false;
      }
    }

    void refresh();

    const interval = window.setInterval(
      () => void refresh(),
      1500,
    );

    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const approval = pending[0] ?? null;

  async function decide(approve: boolean) {
    if (!approval || busy) return;

    setBusy(true);
    setError("");

    try {
      const response = await authenticatedFetch(
        `${API_URL}/mcp/approvals/${encodeURIComponent(
          approval.id,
        )}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ approve }),
        },
      );

      if (!response.ok) {
        throw new Error(
          "This approval has expired or could not be processed.",
        );
      }

      setPending((current) =>
        current.filter((item) => item.id !== approval.id),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to process the approval.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={approval !== null}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[3000] bg-black/65 backdrop-blur-[3px]" />

        <Dialog.Content
          onEscapeKeyDown={(event) =>
            event.preventDefault()
          }
          onPointerDownOutside={(event) =>
            event.preventDefault()
          }
          className="fixed left-1/2 top-1/2 z-[3001] flex max-h-[85vh] w-[min(92vw,540px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[color:var(--border-strong)] bg-[color:var(--surface)] p-5 text-[color:var(--foreground)] shadow-2xl outline-none"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
              <ShieldCheck size={22} />
            </div>

            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[16px] font-semibold">
                Approve external action
              </Dialog.Title>

              <Dialog.Description className="mt-1 text-[12px] leading-5 text-[color:var(--muted-foreground)]">
                Clawbit wants to perform an action using a
                connected service. Review the details before
                allowing it.
              </Dialog.Description>
            </div>
          </div>

          {approval && (
            <>
              <div className="mt-5 space-y-3 overflow-y-auto">
                <div className="grid grid-cols-[85px_1fr] gap-2 text-[12px]">
                  <span className="text-[color:var(--muted-foreground)]">
                    Service
                  </span>

                  <span className="font-medium">
                    {PROVIDERS[approval.provider] ??
                      approval.provider}
                  </span>

                  <span className="text-[color:var(--muted-foreground)]">
                    Action
                  </span>

                  <span className="break-all font-medium">
                    {approval.tool}
                  </span>
                </div>

                <div>
                  <p className="mb-2 text-[12px] font-medium">
                    Arguments
                  </p>

                  <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-all rounded-xl border border-[color:var(--border)] bg-[color:var(--background)] p-3 font-mono text-[11px] leading-5">
                    {approval.arguments}
                  </pre>
                </div>

                <div className="flex items-start gap-2 rounded-lg bg-amber-500/[0.08] p-3 text-[11px] leading-5 text-[color:var(--foreground)]">
                  <AlertTriangle
                    size={15}
                    className="mt-0.5 shrink-0 text-amber-500"
                  />

                  <span>
                    Approving may change data outside Clawbit.
                    Only approve actions you explicitly
                    requested and whose arguments you recognise.
                    Approval expires automatically.
                  </span>
                </div>

                <p className="text-[11px] text-[color:var(--muted-foreground)]">
                  Expires in approximately{" "}
                  {approval.expires_in} seconds.
                </p>

                {error && (
                  <p role="alert" className="text-[12px] text-red-500">
                    {error}
                  </p>
                )}
              </div>

              <div className="mt-5 flex justify-end gap-2 border-t border-[color:var(--border)] pt-4">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(false)}
                  className="h-10 rounded-lg border border-[color:var(--border-strong)] px-4 text-[12px] font-medium transition-colors hover:bg-[color:var(--accent-hover)] disabled:opacity-50"
                >
                  Deny
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(true)}
                  className="h-10 rounded-lg bg-[color:var(--foreground)] px-4 text-[12px] font-semibold text-[color:var(--background)] transition-opacity hover:opacity-85 disabled:opacity-50"
                >
                  {busy ? "Processing..." : "Approve once"}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
