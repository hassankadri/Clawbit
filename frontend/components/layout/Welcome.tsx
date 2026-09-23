"use client";

import { motion } from "framer-motion";
import {
  BrainCircuit,
  Code2,
  FileText,
  Globe,
} from "lucide-react";

import ClawbitMark from "@/components/brand/ClawbitMark";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const suggestions = [
  {
    title: "Build AI Agent",
    description: "Create intelligent agents with custom tools",
    icon: BrainCircuit,
    prompt:
      "Help me build an AI agent for customer support with tools and memory.",
  },
  {
    title: "Analyze Documents",
    description: "Extract insights from your documents",
    icon: FileText,
    prompt:
      "Analyze a product requirements document and summarize the risks and open questions.",
  },
  {
    title: "Research the Web",
    description: "Get real-time information from the web",
    icon: Globe,
    prompt:
      "Research the latest competitors in the AI workspace market and compare their positioning.",
  },
  {
    title: "Write Code",
    description: "Generate, debug and explain code",
    icon: Code2,
    prompt:
      "Help me architect a clean Next.js frontend shell for an AI product.",
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
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col items-center justify-center px-5 pb-7 pt-2 lg:px-8">
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
        className="flex flex-col items-center"
      >
        <div
          className={cn(
            "mb-7 flex h-[72px] w-[72px] items-center justify-center rounded-[20px] border shadow-none",
            theme === "dark"
              ? "border-white/[0.04] bg-[radial-gradient(circle,_rgba(255,255,255,0.03),_rgba(11,13,17,0.95))]"
              : "border-slate-300 bg-[radial-gradient(circle,_rgba(139,92,246,0.10),_rgba(244,246,250,0.98))]",
          )}
        >
          <ClawbitMark
            className={cn(
              "h-10 w-10",
              theme === "dark" ? "text-white" : "text-slate-900",
            )}
          />
        </div>

        <h1 className="text-center text-[42px] font-semibold tracking-tight md:text-[50px] lg:text-[56px]">
          <span
            className={cn(
              theme === "dark"
                ? "text-white"
                : "bg-gradient-to-r from-violet-500 via-fuchsia-500 to-blue-500 bg-clip-text text-transparent",
            )}
          >
            Start a conversation
          </span>
        </h1>

        <p
          className={cn(
            "mt-4 max-w-2xl text-center text-[16px] leading-7",
            theme === "dark" ? "text-zinc-400" : "text-slate-700",
          )}
        >
          Ask a question, upload a file, or choose a prompt below. Your
          chat history will appear here once you begin.
        </p>
      </motion.div>

      <div className="mt-10 grid w-full max-w-5xl gap-4 md:grid-cols-2 xl:grid-cols-4">
        {suggestions.map((item, index) => {
          const Icon = item.icon;

          return (
            <motion.button
              key={item.title}
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                delay: 0.08 * index,
                duration: 0.35,
              }}
              onClick={() =>
                onSuggestionSelect(item.prompt)
              }
              className={cn(
                "ui-card group p-[18px] text-left backdrop-blur-xl transition hover:-translate-y-1 hover:shadow-none",
                theme === "dark"
                  ? "border-white/[0.04] bg-[color:var(--surface)] shadow-none dark:rounded-[14px] hover:border-white/[0.05] hover:bg-[color:var(--card)]"
                  : "bg-[color:var(--panel)] hover:border-violet-300 hover:bg-[color:var(--card)]",
            )}
          >
              <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[color:var(--accent-hover)] text-violet-500 transition duration-200 group-hover:scale-[1.03] group-hover:shadow-none">
                <Icon size={20} />
              </div>
              <h3 className="mt-6 text-[17px] font-semibold">
                {item.title}
              </h3>
              <p
                className={cn(
                  "mt-2.5 text-[14px] leading-6",
                  theme === "dark" ? "text-zinc-400" : "text-slate-600",
                )}
              >
                {item.description}
              </p>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
