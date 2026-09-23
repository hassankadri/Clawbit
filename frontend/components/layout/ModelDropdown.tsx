"use client";

import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  ChevronDown,
  Check,
  Bot,
} from "lucide-react";

interface Props {
  model: string;
  onChange: (model: string) => void;
}

const GEMINI = [
  "Gemini 2.5 Pro",
  "Gemini 2.5 Flash",
  "Gemini 1.5 Pro",
  "Gemini 1.5 Flash",
];

const OTHER = [
  {
    name: "Claude 3.5 Sonnet",
    color: "text-orange-400",
  },
  {
    name: "GPT-4o",
    color: "text-green-400",
  },
  {
    name: "Llama 3.1 70B",
    color: "text-blue-400",
  },
];

export default function ModelDropdown({
  model,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);

  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function click(e: MouseEvent) {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }

    window.addEventListener("mousedown", click);

    return () =>
      window.removeEventListener(
        "mousedown",
        click
      );
  }, []);

  return (
    <div
      ref={ref}
      className="relative"
    >
      <button
        onClick={() => setOpen(!open)}
        className="ui-button ui-button-secondary px-4"
      >
        <Sparkles
          size={18}
          className="text-violet-400"
        />

        <span className="text-[14px] font-medium">
          {model}
        </span>

        <ChevronDown size={15} />
      </button>

      {open && (
        <div className="ui-menu-surface absolute left-0 top-14 z-50 w-72 p-4">

          <p className="mb-3 text-[11px] uppercase tracking-widest text-[color:var(--muted-foreground)]">
            Recent
          </p>

          <div className="space-y-1">

            {GEMINI.map((item) => (
              <button
                key={item}
                onClick={() => {
                  onChange(item);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-[14px] px-3 py-2.5 transition hover:bg-[color:var(--accent-hover)]"
              >
                <div className="flex items-center gap-3">

                  <Sparkles
                    size={18}
                    className="text-violet-400"
                  />

                  <span className="text-[14px]">
                    {item}
                  </span>

                </div>

                {model === item && (
                  <Check
                    size={16}
                    className="text-violet-400"
                  />
                )}

              </button>
            ))}

          </div>

          <div className="my-4 border-t border-[color:var(--border)]" />

          <p className="mb-3 text-[11px] uppercase tracking-widest text-[color:var(--muted-foreground)]">
            Other Models
          </p>

          <div className="space-y-1">

            {OTHER.map((item) => (
              <button
                key={item.name}
                onClick={() => {
                  onChange(item.name);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-[14px] px-3 py-2.5 transition hover:bg-[color:var(--accent-hover)]"
              >
                <div className="flex items-center gap-3">

                  <Bot
                    size={18}
                    className={item.color}
                  />

                  <span className="text-[14px]">
                    {item.name}
                  </span>

                </div>

                {model === item.name && (
                  <Check
                    size={16}
                    className="text-violet-400"
                  />
                )}

              </button>
            ))}

          </div>

          <div className="my-4 border-t border-[color:var(--border)]" />

          <button className="flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 transition hover:bg-[color:var(--accent-hover)]">

            <Bot size={18} />

            <span className="text-[14px]">
              Manage Models
            </span>

          </button>

        </div>
      )}
    </div>
  );
}
