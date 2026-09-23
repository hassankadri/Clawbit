"use client";

import {
  Check,
  Copy,
  RotateCcw,
  Trash2,
  Square,
} from "lucide-react";
import { useState } from "react";

import ClawbitMark from "@/components/brand/ClawbitMark";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import Markdown from "./Markdown";
import Thinking from "./Thinking";

interface Props {
  content: string;
  theme: Theme;
  status?: "complete" | "streaming" | "error";
  onDelete: () => void;
  onRetry: () => void | Promise<void>;
  onStop: () => void;
}

export default function AssistantMessage({
  content,
  theme,
  status = "complete",
  onDelete,
  onRetry,
  onStop,
}: Props) {
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    await navigator.clipboard.writeText(content);
    setCopied(true);

    setTimeout(() => {
      setCopied(false);
    }, 1500);
  }

  return (
    <div className="group flex items-start gap-3">
      <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[color:var(--surface)] text-violet-400 shadow-[0_8px_20px_rgba(0,0,0,0.18)]">
        <ClawbitMark className="h-5 w-5 text-current" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-2">
          <h3
            className={cn(
              "text-[14px] font-medium",
              theme === "dark" ? "text-white" : "text-slate-900",
            )}
          >
            Clawbit AI
          </h3>
        </div>

        <div
          className={cn(
            "max-w-[min(100%,760px)] text-[14px] leading-7",
            theme === "dark" ? "text-zinc-100" : "text-slate-800",
            status === "error"
              ? theme === "dark"
                ? "text-rose-300"
                : "text-rose-700"
              : "",
          )}
        >
          {status === "streaming" && content.trim().length === 0 ? (
            <div className="flex items-center justify-between gap-4">
              <span
                className={cn(
                  "text-[14px]",
                  theme === "dark" ? "text-zinc-400" : "text-slate-500",
                )}
              >
                Generating response...
              </span>
              <button
                type="button"
                onClick={onStop}
                className="ui-button ui-button-secondary h-9 px-3 text-[12px] text-violet-500"
              >
                Stop
              </button>
            </div>
          ) : status === "error" ? (
            <div className="space-y-3">
              <p className={theme === "dark" ? "text-rose-300" : "text-rose-700"}>
                {content}
              </p>
              <button
                type="button"
                onClick={onRetry}
                className={cn(
                  "ui-button ui-button-secondary h-9 px-3 text-[12px]",
                  theme === "dark" ? "text-rose-300" : "text-rose-700",
                )}
              >
                Retry
              </button>
            </div>
          ) : status === "streaming" && content.trim().length === 0 ? (
            <Thinking theme={theme} />
          ) : (
            <Markdown content={content} />
          )}
        </div>

        <div className="mt-2 flex items-center gap-1.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            title="Copy response"
            onClick={copyMessage}
            className="rounded-full p-1.5 transition hover:bg-[color:var(--accent-hover)]"
          >
            {copied ? (
              <Check size={15} className="text-green-400" />
            ) : (
              <Copy
                size={15}
                className={
                  theme === "dark"
                    ? "text-zinc-500 hover:text-white"
                    : "text-slate-400 hover:text-slate-900"
                }
              />
            )}
          </button>
          <button
            type="button"
            title="Retry response"
            onClick={onRetry}
            className={cn(
              "rounded-full p-1.5 transition hover:bg-[color:var(--accent-hover)]",
              theme === "dark"
                ? "text-zinc-500 hover:text-white"
                : "text-slate-400 hover:text-slate-900",
            )}
          >
            <RotateCcw size={15} />
          </button>
          <button
            type="button"
            title="Delete message"
            onClick={onDelete}
            className={cn(
              "rounded-full p-1.5 transition hover:bg-[color:var(--accent-hover)]",
              theme === "dark"
                ? "text-zinc-500 hover:text-white"
                : "text-slate-400 hover:text-slate-900",
            )}
          >
            <Trash2 size={15} />
          </button>
          {status === "streaming" ? (
            <button
              type="button"
              title="Stop generation"
              onClick={onStop}
              className="rounded-full p-1.5 text-violet-500 transition hover:bg-[color:var(--accent-hover)]"
            >
              <Square size={15} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
