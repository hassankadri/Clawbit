"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import {
  Check,
  Copy,
  MoreHorizontal,
  RotateCcw,
  Share2,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  VolumeX,
} from "lucide-react";

import {
  useEffect,
  useRef,
  useState,
} from "react";

import ClawbitMark from "@/components/brand/ClawbitMark";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

import Markdown from "./Markdown";

interface Props {
  content: string;

  theme: Theme;

  assistantName: string;

  status?:
    | "complete"
    | "streaming"
    | "error";

  /*
   * Kept for compatibility with Message.tsx.
   * Delete is intentionally not shown.
   */
  onDelete: () => void;

  onRetry:
    () => void | Promise<void>;

  onStop: () => void;
}

type Feedback =
  | "up"
  | "down"
  | null;

export default function AssistantMessage({
  content,
  theme,
  assistantName,
  status = "complete",
  onRetry,
  onStop,
}: Props) {
  const isDark =
    theme === "dark";

  const waiting =
    status === "streaming" &&
    content.trim().length ===
      0;

  const [
    copied,
    setCopied,
  ] = useState(false);

  const [
    shared,
    setShared,
  ] = useState(false);

  const [
    feedback,
    setFeedback,
  ] =
    useState<Feedback>(
      null,
    );

  const [
    speaking,
    setSpeaking,
  ] = useState(false);

  const copyTimerRef =
    useRef<number | null>(
      null,
    );

  const shareTimerRef =
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

      if (
        shareTimerRef.current !==
        null
      ) {
        window.clearTimeout(
          shareTimerRef.current,
        );
      }

      window.speechSynthesis?.cancel();
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
  /* SHARE                                                  */
  /* ====================================================== */

  async function shareMessage() {
    try {
      if (
        typeof navigator.share ===
        "function"
      ) {
        await navigator.share({
          title:
            `${assistantName} response`,

          text:
            content,
        });
      } else {
        await navigator.clipboard.writeText(
          content,
        );
      }

      setShared(
        true,
      );

      if (
        shareTimerRef.current !==
        null
      ) {
        window.clearTimeout(
          shareTimerRef.current,
        );
      }

      shareTimerRef.current =
        window.setTimeout(
          () => {
            setShared(
              false,
            );

            shareTimerRef.current =
              null;
          },
          1500,
        );
    } catch {
      // User cancelled native share.
    }
  }

  /* ====================================================== */
  /* READ ALOUD                                             */
  /* ====================================================== */

  function toggleReadAloud() {
    if (
      !("speechSynthesis" in window)
    ) {
      return;
    }

    if (
      speaking
    ) {
      window.speechSynthesis.cancel();

      setSpeaking(
        false,
      );

      return;
    }

    window.speechSynthesis.cancel();

    const utterance =
      new SpeechSynthesisUtterance(
        content,
      );

    utterance.onend =
      () =>
        setSpeaking(
          false,
        );

    utterance.onerror =
      () =>
        setSpeaking(
          false,
        );

    setSpeaking(
      true,
    );

    window.speechSynthesis.speak(
      utterance,
    );
  }

  /* ====================================================== */
  /* UI                                                     */
  /* ====================================================== */

  return (
    <div className="flex items-start gap-3">
      <div
        className={cn(
          "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border",

          isDark
            ? "border-white/[0.08] bg-[#151515]"
            : "border-black/[0.08] bg-white",
        )}
      >
        <ClawbitMark className="h-[18px] w-[18px]" />
      </div>

      <div className="min-w-0 flex-1">
        <h3
          className={cn(
            "mb-2 text-[13px] font-medium",

            isDark
              ? "text-zinc-200"
              : "text-zinc-900",
          )}
        >
          {assistantName}
        </h3>

        {/* WAITING */}

        {waiting ? (
          <div className="flex min-h-[32px] items-center gap-3">
            <div className="flex gap-[5px]">
              <ThinkingDot
                delay="0ms"
              />

              <ThinkingDot
                delay="160ms"
              />

              <ThinkingDot
                delay="320ms"
              />
            </div>

            <span className="text-[13px] text-zinc-500">
              Working on your request
            </span>

            <button
              type="button"
              onClick={
                onStop
              }
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[11px]",

                isDark
                  ? "text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
                  : "text-zinc-500 hover:bg-black/[0.05] hover:text-zinc-900",
              )}
            >
              <Square
                size={
                  10
                }
                fill="currentColor"
              />

              Stop
            </button>
          </div>
        ) : status ===
          "error" ? (
          <div>
            <p
              className={cn(
                "text-[14px] leading-7",

                isDark
                  ? "text-red-300"
                  : "text-red-700",
              )}
            >
              {content}
            </p>

            <button
              type="button"
              onClick={() =>
                void onRetry()
              }
              className="mt-2 inline-flex items-center gap-2 text-[12px] text-zinc-500 hover:text-[color:var(--foreground)]"
            >
              <RotateCcw
                size={
                  13
                }
              />

              Try again
            </button>
          </div>
        ) : (
          <>
            <div
              className={cn(
                "max-w-[min(100%,760px)] text-[14px] leading-7",

                isDark
                  ? "text-zinc-100"
                  : "text-zinc-800",
              )}
            >
              <Markdown
                content={
                  content
                }
              />
            </div>

            {/* ========================================= */}
            {/* CHATGPT-STYLE ALWAYS-VISIBLE AI ACTIONS   */}
            {/* ========================================= */}

            <div className="mt-2 flex min-h-8 items-center gap-0.5">
              <AssistantAction
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
                      15
                    }
                  />
                ) : (
                  <Copy
                    size={
                      15
                    }
                  />
                )}
              </AssistantAction>

              <AssistantAction
                theme={
                  theme
                }
                title="Good response"
                active={
                  feedback ===
                  "up"
                }
                onClick={() =>
                  setFeedback(
                    feedback ===
                      "up"
                      ? null
                      : "up",
                  )
                }
              >
                <ThumbsUp
                  size={
                    15
                  }
                />
              </AssistantAction>

              <AssistantAction
                theme={
                  theme
                }
                title="Bad response"
                active={
                  feedback ===
                  "down"
                }
                onClick={() =>
                  setFeedback(
                    feedback ===
                      "down"
                      ? null
                      : "down",
                  )
                }
              >
                <ThumbsDown
                  size={
                    15
                  }
                />
              </AssistantAction>

              <AssistantAction
                theme={
                  theme
                }
                title={
                  shared
                    ? "Shared"
                    : "Share"
                }
                onClick={() =>
                  void shareMessage()
                }
              >
                {shared ? (
                  <Check
                    size={
                      15
                    }
                  />
                ) : (
                  <Share2
                    size={
                      15
                    }
                  />
                )}
              </AssistantAction>

              <AssistantAction
                theme={
                  theme
                }
                title={
                  speaking
                    ? "Stop reading"
                    : "Read aloud"
                }
                active={
                  speaking
                }
                onClick={
                  toggleReadAloud
                }
              >
                {speaking ? (
                  <VolumeX
                    size={
                      15
                    }
                  />
                ) : (
                  <Volume2
                    size={
                      15
                    }
                  />
                )}
              </AssistantAction>

              <AssistantAction
                theme={
                  theme
                }
                title="Regenerate"
                onClick={() =>
                  void onRetry()
                }
              >
                <RotateCcw
                  size={
                    15
                  }
                />
              </AssistantAction>

              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  asChild
                >
                  <button
                    type="button"
                    title="More"
                    aria-label="More"
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-[8px] transition-colors",

                      isDark
                        ? "text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200"
                        : "text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-900",
                    )}
                  >
                    <MoreHorizontal
                      size={
                        16
                      }
                    />
                  </button>
                </DropdownMenu.Trigger>

                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="start"
                    side="bottom"
                    sideOffset={
                      6
                    }
                    className="ui-menu-surface z-[1200] min-w-[185px] p-1.5"
                  >
                    <DropdownMenu.Item
                      onSelect={() =>
                        void copyMessage()
                      }
                      className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-2 text-[12px] text-[color:var(--foreground)] outline-none hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)]"
                    >
                      <Copy
                        size={
                          14
                        }
                      />

                      Copy as Markdown
                    </DropdownMenu.Item>

                    <DropdownMenu.Item
                      onSelect={() =>
                        void shareMessage()
                      }
                      className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-2 text-[12px] text-[color:var(--foreground)] outline-none hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)]"
                    >
                      <Share2
                        size={
                          14
                        }
                      />

                      Share response
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ThinkingDot({
  delay,
}: {
  delay:
    string;
}) {
  return (
    <span
      className="h-[5px] w-[5px] animate-pulse rounded-full bg-zinc-500"
      style={{
        animationDelay:
          delay,
      }}
    />
  );
}

function AssistantAction({
  theme,
  title,
  active = false,
  onClick,
  children,
}: {
  theme: Theme;

  title: string;

  active?: boolean;

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
      aria-pressed={
        active
      }
      onClick={
        onClick
      }
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-[8px] transition-colors",

        active
          ? isDark
            ? "bg-white/[0.09] text-white"
            : "bg-black/[0.07] text-black"
          : isDark
            ? "text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200"
            : "text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-900",
      )}
    >
      {children}
    </button>
  );
}