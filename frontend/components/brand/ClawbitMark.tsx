"use client";

import { cn } from "@/lib/utils";

type Variant = "icon" | "horizontal" | "stacked";

interface ClawbitMarkProps {
  variant?: Variant;
  className?: string;
  iconClassName?: string;
  wordmarkClassName?: string;
}

export default function ClawbitMark({
  variant = "icon",
  className,
  iconClassName,
  wordmarkClassName,
}: ClawbitMarkProps) {
  if (variant === "horizontal") {
    return (
      <div className={cn("inline-flex items-center gap-3", className)}>
        <LogoIcon className={iconClassName} />
        <LogoWordmark className={wordmarkClassName} />
      </div>
    );
  }

  if (variant === "stacked") {
    return (
      <div className={cn("inline-flex flex-col items-center gap-2", className)}>
        <LogoIcon className={iconClassName} />
        <LogoWordmark className={wordmarkClassName} stacked />
      </div>
    );
  }

  return <LogoIcon className={className ?? iconClassName} />;
}

function LogoIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("block shrink-0", className)}
    >
      <g fill="currentColor">
        <path d="M17 14.5 29.8 9l-11.6 17.1L9 31.4l3.6-10.3L17 14.5Z" />
        <path d="M32.6 8.8 43.2 9l-8.9 8.6-8.7 2.7 7-11.5Z" />
        <path d="M38.5 17.8 56 13.2 41.2 28l-8.9 4.2 6.2-14.4Z" />
        <path d="M18.3 34.4 29 31.2 24 41.5l-8.9 11.2-6.4-8.6 9.6-9.7Z" />
        <path d="M34.8 29.8 50.5 24.7 39 36.7l-9.4 5.3 5.2-12.2Z" />
        <path d="M39.7 40.4 56 34.4 44.9 47.9 30.6 55l9.1-14.6Z" />
      </g>

      <path
        d="M24.6 25.7 43.8 16.6 35.1 29.1 21.4 36l3.2-10.3Z"
        fill="#3b82f6"
      />
      <path
        d="M27.7 39.5 47.7 30.1 38.3 42.7 25.4 48.3l2.3-8.8Z"
        fill="#3b82f6"
      />
    </svg>
  );
}

function LogoWordmark({
  stacked,
  className,
}: {
  stacked?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-1.5 font-semibold tracking-[-0.04em]",
        stacked ? "justify-center" : "",
        className,
      )}
    >
      <span className="text-inherit">Clawbit</span>
      <span className="text-[0.55em] font-semibold uppercase tracking-[0.28em] text-violet-500">
        AI
      </span>
    </div>
  );
}
