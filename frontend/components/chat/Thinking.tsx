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
  const isDark = theme === "dark";

  return (
    <div className="flex animate-in gap-4 fade-in duration-300">
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] border shadow-[0_8px_20px_rgba(0,0,0,0.12)]",
          "border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--foreground)]",
        )}
      >
        <ClawbitMark className="h-5 w-5 text-current" />
      </div>

      <div className="flex flex-col">
        <h3
          className={cn(
            "mb-2.5 text-[14px] font-medium",
            isDark ? "text-zinc-100" : "text-zinc-900",
          )}
        >
          Clawbit AI
        </h3>

        <div className="flex items-center gap-2 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-2.5">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              aria-hidden="true"
              className={cn(
                "h-1.5 w-1.5 animate-bounce rounded-full",
                isDark ? "bg-zinc-400" : "bg-zinc-500",
              )}
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}

          <span
            className={cn(
              "ml-3 text-[13px]",
              isDark ? "text-zinc-400" : "text-zinc-500",
            )}
          >
            Thinking...
          </span>
        </div>
      </div>
    </div>
  );
}