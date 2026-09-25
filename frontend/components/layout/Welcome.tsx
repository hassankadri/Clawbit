"use client";

import { motion } from "framer-motion";
import {
  BrainCircuit,
  Code2,
  FileText,
  Globe,
  Sparkles,
} from "lucide-react";

import ClawbitMark from "@/components/brand/ClawbitMark";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const suggestions = [
  {
    title: "Ask anything",
    description: "Reason through a problem or explore an idea",
    icon: Sparkles,
    prompt:
      "Help me think through a difficult problem step by step.",
  },
  {
    title: "Analyze files",
    description: "Upload documents and ask grounded questions",
    icon: FileText,
    prompt:
      "I want to analyze a document and extract the most important insights.",
  },
  {
    title: "Research the web",
    description: "Use live sources for deeper research",
    icon: Globe,
    prompt:
      "Research a topic for me and summarize the most important findings.",
  },
  {
    title: "Build with AI",
    description: "Design, debug, and improve software",
    icon: Code2,
    prompt:
      "Help me design and build a production-ready AI feature.",
  },
];

interface WelcomeProps {
  theme: Theme;
  onSuggestionSelect: (prompt: string) => void;
}

export default function Welcome({
  theme,
  onSuggestionSelect,
}: WelcomeProps) {
  return (
    <div className="clawbit-glow relative flex h-full w-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[980px] flex-col justify-center px-5 pb-24 pt-14 sm:px-8 lg:px-10">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.42, ease: "easeOut" }}
          className="mx-auto flex max-w-3xl flex-col items-center text-center"
        >
          <div
            className={cn(
              "relative mb-7 flex h-16 w-16 items-center justify-center rounded-[20px] border",
              theme === "dark"
                ? "border-white/[0.07] bg-white/[0.035]"
                : "border-slate-200 bg-white shadow-[0_12px_40px_rgba(15,23,42,0.08)]",
            )}
          >
            <div className="absolute inset-0 rounded-[20px] bg-[radial-gradient(circle_at_35%_25%,rgba(139,124,255,0.18),transparent_55%)]" />
            <ClawbitMark
              className={cn(
                "relative h-8 w-8",
                theme === "dark"
                  ? "text-white"
                  : "text-slate-950",
              )}
            />
          </div>

          <div
            className={cn(
              "mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em]",
              theme === "dark"
                ? "border-white/[0.07] bg-white/[0.025] text-zinc-400"
                : "border-slate-200 bg-white/80 text-slate-500",
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            AI workspace
          </div>

          <h1
            className={cn(
              "max-w-[760px] text-balance text-[36px] font-semibold leading-[1.08] tracking-[-0.035em] sm:text-[46px] lg:text-[54px]",
              theme === "dark"
                ? "text-white"
                : "text-slate-950",
            )}
          >
            What are we working on?
          </h1>

          <p
            className={cn(
              "mt-5 max-w-[610px] text-pretty text-[15px] leading-7 sm:text-[16px]",
              theme === "dark"
                ? "text-zinc-400"
                : "text-slate-600",
            )}
          >
            Chat, research the web, work with documents, and build with
            multiple AI models from one focused workspace.
          </p>
        </motion.div>

        <div className="mt-12 grid w-full gap-3 sm:grid-cols-2">
          {suggestions.map((item, index) => {
            const Icon = item.icon;

            return (
              <motion.button
                key={item.title}
                type="button"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: 0.06 + index * 0.055,
                  duration: 0.3,
                }}
                onClick={() =>
                  onSuggestionSelect(item.prompt)
                }
                className={cn(
                  "group flex min-h-[92px] items-center gap-4 rounded-[18px] border p-4 text-left",
                  theme === "dark"
                    ? "border-white/[0.065] bg-white/[0.025] hover:border-white/[0.11] hover:bg-white/[0.045]"
                    : "border-slate-200 bg-white/75 shadow-[0_8px_30px_rgba(15,23,42,0.035)] hover:border-slate-300 hover:bg-white",
                )}
              >
                <div
                  className={cn(
                    "flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border transition-transform duration-200 group-hover:scale-[1.04]",
                    theme === "dark"
                      ? "border-white/[0.06] bg-white/[0.035] text-violet-300"
                      : "border-violet-100 bg-violet-50 text-violet-600",
                  )}
                >
                  <Icon size={19} />
                </div>

                <div className="min-w-0">
                  <p className="text-[14px] font-semibold tracking-[-0.01em]">
                    {item.title}
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-[13px] leading-5",
                      theme === "dark"
                        ? "text-zinc-500"
                        : "text-slate-500",
                    )}
                  >
                    {item.description}
                  </p>
                </div>
              </motion.button>
            );
          })}
        </div>

        <div
          className={cn(
            "mx-auto mt-7 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11px]",
            theme === "dark"
              ? "text-zinc-600"
              : "text-slate-400",
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <BrainCircuit size={13} />
            Memory
          </span>
          <span>•</span>
          <span>Document RAG</span>
          <span>•</span>
          <span>Research mode</span>
          <span>•</span>
          <span>Multiple models</span>
        </div>
      </div>
    </div>
  );
}
