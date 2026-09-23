"use client";

import ClawbitMark from "@/components/brand/ClawbitMark";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface ThinkingProps {
  theme: Theme;
}

export default function Thinking({
  theme,
}: ThinkingProps) {
  return (
    <div className="flex gap-4 animate-in fade-in duration-300">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[color:var(--surface)] text-violet-400 shadow-[0_8px_20px_rgba(0,0,0,0.18)]">
        <ClawbitMark className="h-5 w-5 text-current" />
      </div>

      <div className="flex flex-col">
        <h3
          className={cn(
            "mb-2.5 text-[14px] font-medium",
            theme === "dark" ? "text-white" : "text-slate-900",
          )}
        >
          Clawbit AI
        </h3>

        <div
          className={cn(
            "flex items-center gap-2 rounded-[16px] border px-4 py-2.5",
            theme === "dark"
              ? "border-[color:var(--border)] bg-[color:var(--surface)]"
              : "border-[color:var(--border)] bg-[color:var(--surface)]",
          )}
        >
          <span
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400"
            style={{ animationDelay: "0ms" }}
          />
          <span
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400"
            style={{ animationDelay: "300ms" }}
          />

          <span
          className={cn(
            "ml-3 text-[13px]",
            theme === "dark" ? "text-zinc-400" : "text-slate-500",
          )}
        >
            Thinking...
          </span>
        </div>
      </div>
    </div>
  );
}
