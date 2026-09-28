"use client";

import {
  Check,
  Copy,
  Pencil,
  X,
} from "lucide-react";

import {
  useEffect,
  useRef,
  useState,
} from "react";

import UserAvatar from "@/components/common/UserAvatar";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface Props {
  content: string;

  theme: Theme;

  onEdit: (
    nextContent: string,
  ) => void | Promise<void>;

  /*
   * Kept in the prop contract so Message.tsx
   * does not need to change.
   *
   * Delete is intentionally NOT exposed in the UI.
   */
  onDelete: () => void;
}

export default function UserMessage({
  content,
  theme,
  onEdit,
}: Props) {
  const isDark =
    theme === "dark";

  const [
    isEditing,
    setIsEditing,
  ] = useState(false);

  const [
    draft,
    setDraft,
  ] = useState(content);

  const [
    copied,
    setCopied,
  ] = useState(false);

  const [
    saving,
    setSaving,
  ] = useState(false);

  const copyTimerRef =
    useRef<number | null>(
      null,
    );

  /* ====================================================== */
  /* CLEANUP                                                */
  /* ====================================================== */

  useEffect(() => {
    return () => {
      if (
        copyTimerRef.current !==
        null
      ) {
        window.clearTimeout(
          copyTimerRef.current,
        );
      }
    };
  }, []);

  /* ====================================================== */
  /* COPY                                                   */
  /* ====================================================== */

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(
        content,
      );

      setCopied(
        true,
      );

      if (
        copyTimerRef.current !==
        null
      ) {
        window.clearTimeout(
          copyTimerRef.current,
        );
      }

      copyTimerRef.current =
        window.setTimeout(
          () => {
            setCopied(
              false,
            );

            copyTimerRef.current =
              null;
          },
          1500,
        );
    } catch {
      setCopied(
        false,
      );
    }
  }

  /* ====================================================== */
  /* EDIT                                                   */
  /* ====================================================== */

  function startEditing() {
    setDraft(
      content,
    );

    setIsEditing(
      true,
    );
  }

  function cancelEditing() {
    if (
      saving
    ) {
      return;
    }

    setDraft(
      content,
    );

    setIsEditing(
      false,
    );
  }

  async function handleSave() {
    const nextContent =
      draft.trim();

    if (
      !nextContent ||
      saving
    ) {
      return;
    }

    if (
      nextContent ===
      content.trim()
    ) {
      setIsEditing(
        false,
      );

      return;
    }

    setSaving(
      true,
    );

    try {
      await onEdit(
        nextContent,
      );

      setIsEditing(
        false,
      );
    } finally {
      setSaving(
        false,
      );
    }
  }

  /* ====================================================== */
  /* UI                                                     */
  /* ====================================================== */

  return (
    <div className="group flex justify-end">
      <div className="flex max-w-[min(86%,760px)] flex-row-reverse items-start gap-3">
        <UserAvatar className="mt-0.5" />

        <div className="flex min-w-0 flex-1 flex-col items-end">
          {isEditing ? (
            <div
              className={cn(
                "w-full min-w-[280px] rounded-[18px] border p-3",

                isDark
                  ? "border-white/[0.08] bg-[#111111]"
                  : "border-black/[0.08] bg-white",
              )}
            >
              <textarea
                autoFocus
                value={
                  draft
                }
                onChange={(
                  event,
                ) =>
                  setDraft(
                    event.target.value,
                  )
                }
                onKeyDown={(
                  event,
                ) => {
                  if (
                    event.key ===
                    "Escape"
                  ) {
                    cancelEditing();
                  }

                  if (
                    event.key ===
                      "Enter" &&
                    !event.shiftKey
                  ) {
                    event.preventDefault();

                    void handleSave();
                  }
                }}
                rows={Math.max(
                  2,
                  Math.min(
                    8,
                    draft.split(
                      "\n",
                    ).length,
                  ),
                )}
                className={cn(
                  "min-h-[76px] w-full resize-none rounded-[12px] border px-3 py-2.5 text-[14px] leading-6 outline-none shadow-none",

                  isDark
                    ? "border-white/[0.09] bg-[#0b0b0b] text-zinc-100"
                    : "border-black/[0.10] bg-white text-zinc-900",
                )}
              />

              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={
                    saving
                  }
                  onClick={
                    cancelEditing
                  }
                  className={cn(
                    "inline-flex h-9 items-center gap-2 rounded-[9px] px-3 text-[12px]",

                    isDark
                      ? "text-zinc-400 hover:bg-white/[0.06] hover:text-white"
                      : "text-zinc-600 hover:bg-black/[0.05] hover:text-black",
                  )}
                >
                  <X
                    size={
                      14
                    }
                  />

                  Cancel
                </button>

                <button
                  type="button"
                  disabled={
                    saving ||
                    !draft.trim()
                  }
                  onClick={() =>
                    void handleSave()
                  }
                  className={cn(
                    "inline-flex h-9 items-center gap-2 rounded-[9px] px-3 text-[12px] font-medium disabled:opacity-40",

                    isDark
                      ? "bg-white text-black"
                      : "bg-black text-white",
                  )}
                >
                  <Check
                    size={
                      14
                    }
                  />

                  {saving
                    ? "Saving..."
                    : "Save & Regenerate"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className={cn(
                  "whitespace-pre-wrap break-words rounded-[18px] px-4 py-3 text-[14px] leading-6",

                  isDark
                    ? "bg-white/[0.08] text-zinc-100"
                    : "bg-zinc-100 text-zinc-900",
                )}
              >
                {content}
              </div>

              {/* USER ACTIONS — HOVER ONLY */}

              <div className="mt-1 flex h-8 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                <UserAction
                  theme={
                    theme
                  }
                  title={
                    copied
                      ? "Copied"
                      : "Copy"
                  }
                  onClick={() =>
                    void copyMessage()
                  }
                >
                  {copied ? (
                    <Check
                      size={
                        14
                      }
                    />
                  ) : (
                    <Copy
                      size={
                        14
                      }
                    />
                  )}
                </UserAction>

                <UserAction
                  theme={
                    theme
                  }
                  title="Edit message"
                  onClick={
                    startEditing
                  }
                >
                  <Pencil
                    size={
                      14
                    }
                  />
                </UserAction>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ======================================================== */
/* ACTION                                                   */
/* ======================================================== */

function UserAction({
  theme,
  title,
  onClick,
  children,
}: {
  theme: Theme;

  title: string;

  onClick: () => void;

  children:
    React.ReactNode;
}) {
  const isDark =
    theme === "dark";

  return (
    <button
      type="button"
      title={
        title
      }
      aria-label={
        title
      }
      onClick={
        onClick
      }
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-[8px] transition-colors",

        isDark
          ? "text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200"
          : "text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-900",
      )}
    >
      {children}
    </button>
  );
}