"use client";

import { useState } from "react";
import { Check, Copy, Pencil, Trash2, X } from "lucide-react";

import UserAvatar from "@/components/common/UserAvatar";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface Props {
  content: string;
  theme: Theme;
  onEdit: (nextContent: string) => void | Promise<void>;
  onDelete: () => void;
}

export default function UserMessage({
  content,
  theme,
  onEdit,
  onDelete,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    await navigator.clipboard.writeText(content);
    setCopied(true);

    setTimeout(() => {
      setCopied(false);
    }, 1500);
  }

  async function handleSave() {
    const nextContent = draft.trim();
    if (!nextContent) return;

    await onEdit(nextContent);
    setIsEditing(false);
  }

  return (
    <div className="group flex justify-end">
      <div className="flex max-w-[min(86%,760px)] flex-row-reverse items-start gap-3">
        <UserAvatar className="mt-0.5" />

        <div className="flex min-w-0 flex-col items-end">
          {isEditing ? (
            <div
              className={cn(
                "rounded-[18px] rounded-br-[8px] border p-3 shadow-[0_8px_20px_rgba(15,23,42,0.04)]",
                theme === "dark"
                  ? "border-white/8 bg-[color:var(--surface)]"
                  : "border-slate-300 bg-white",
              )}
            >
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={Math.max(2, Math.min(8, draft.split("\n").length))}
                className={cn(
                  "min-h-[68px] w-full resize-none rounded-[14px] border bg-transparent px-3 py-2 text-[14px] leading-6 outline-none",
                  theme === "dark"
                    ? "border-white/8 text-white placeholder:text-zinc-500"
                    : "border-slate-300 text-slate-950 placeholder:text-slate-500",
                )}
              />

              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDraft(content);
                    setIsEditing(false);
                  }}
                  className={cn(
                    "ui-button ui-button-secondary h-9 px-3 text-[12px]",
                    theme === "dark" ? "text-zinc-300" : "text-slate-700",
                  )}
                >
                  <X size={14} />
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  className="ui-button ui-button-primary h-9 px-3 text-[12px]"
                >
                  <Check size={14} />
                  Save & Regenerate
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className={cn(
                  "rounded-[18px] rounded-br-[8px] px-4 py-3 text-[14px] leading-6",
                  theme === "dark"
                    ? "bg-white/6 text-white"
                    : "bg-slate-100 text-slate-950",
                )}
              >
                {content}
              </div>

              <div className="mt-2 flex items-center justify-end gap-1.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                title="Copy message"
                onClick={copyMessage}
                className={cn(
                  "rounded-full p-1.5 transition hover:bg-[color:var(--accent-hover)]",
                  copied
                    ? "text-green-400"
                    : theme === "dark"
                      ? "text-zinc-500 hover:text-white"
                      : "text-slate-500 hover:text-slate-950",
                )}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button
                type="button"
                title="Edit message"
                onClick={() => {
                  setDraft(content);
                  setIsEditing(true);
                }}
                className={cn(
                  "rounded-full p-1.5 transition hover:bg-[color:var(--accent-hover)]",
                  theme === "dark"
                    ? "text-zinc-500 hover:text-white"
                    : "text-slate-500 hover:text-slate-950",
                )}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                title="Delete message"
                onClick={onDelete}
                className={cn(
                  "rounded-full p-1.5 transition hover:bg-[color:var(--accent-hover)]",
                  theme === "dark"
                    ? "text-zinc-500 hover:text-white"
                    : "text-slate-500 hover:text-slate-950",
                )}
              >
                <Trash2 size={14} />
              </button>
            </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
