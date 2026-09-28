"use client";

import {
  FileSearch,
  GitBranch,
  Lightbulb,
  ListTodo,
  MessageSquare,
  Search,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";

import {
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface WelcomeProps {
  theme: Theme;

  onSuggestionSelect: (
    prompt: string,
  ) => void;

  conversationKey?: string;

  composer?: ReactNode;
}

interface Suggestion {
  id: string;

  icon: ComponentType<{
    size?: number;
    className?: string;
  }>;

  label: string;

  prompt: string;
}

/* ====================================================== */
/* HEADINGS                                               */
/* ====================================================== */

const headings = [
  "Where should we begin?",
  "Ready when you are.",
  "What can I help with?",
  "What are we working on?",
  "What should we tackle?",
  "What’s on your mind?",
  "How can I help today?",
  "What do you want to build?",
  "What should we explore?",
  "Let’s get something done.",
];

/* ====================================================== */
/* SUGGESTIONS                                            */
/* ====================================================== */

const suggestionGroups: Suggestion[][] = [
  [
    {
      id: "research",
      icon: Search,
      label:
        "Research a topic using current web sources",
      prompt:
        "Research a topic for me using current web sources. Compare the important information and give me a clear summary with sources.",
    },

    {
      id: "document",
      icon: FileSearch,
      label:
        "Analyze a document or PDF I upload",
      prompt:
        "Help me analyze a document. I will upload the file and I want the important information explained clearly.",
    },

    {
      id: "plan",
      icon: ListTodo,
      label:
        "Turn an idea into a clear step-by-step plan",
      prompt:
        "Help me turn my idea into a practical step-by-step plan with priorities and the best next action.",
    },
  ],

  [
    {
      id: "code",
      icon: WandSparkles,
      label:
        "Help me build or debug a software project",
      prompt:
        "Help me build or debug a software project. Work through it step by step and explain what needs to be changed.",
    },

    {
      id: "github",
      icon: GitBranch,
      label:
        "Work with my GitHub repositories and code",
      prompt:
        "Help me work with my GitHub repositories. Review the relevant code or recent activity and tell me what I should do next.",
    },

    {
      id: "rewrite",
      icon: MessageSquare,
      label:
        "Write, rewrite, or improve something",
      prompt:
        "Help me write or improve something. Keep it natural, clear, and well structured.",
    },
  ],

  [
    {
      id: "brainstorm",
      icon: Lightbulb,
      label:
        "Brainstorm ideas and find the strongest options",
      prompt:
        "Brainstorm several strong ideas for me, explain the useful ones, and help me narrow them down.",
    },

    {
      id: "project",
      icon: Sparkles,
      label:
        "Review a project and suggest the best next steps",
      prompt:
        "Review my project context and suggest the most useful next steps, priorities, and improvements.",
    },

    {
      id: "tools",
      icon: GitBranch,
      label:
        "Use connected tools like Drive, Notion, GitHub, and Slack",
      prompt:
        "Help me use my connected tools to find or work with the information I need.",
    },
  ],
];

/* ====================================================== */
/* HASH                                                   */
/* ====================================================== */

function hashString(
  value: string,
) {
  let hash = 0;

  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {
    hash =
      (
        hash * 31 +
        value.charCodeAt(
          index,
        )
      ) >>>
      0;
  }

  return hash;
}

/* ====================================================== */
/* WELCOME                                                */
/* ====================================================== */

export default function Welcome({
  theme,
  onSuggestionSelect,
  conversationKey = "initial",
  composer,
}: WelcomeProps) {
  const isDark =
    theme === "dark";

  /*
   * Keep dismissed suggestions separated by chat.
   *
   * New conversationKey = fresh suggestions automatically.
   * No effect/state synchronization required.
   */
  const [
    dismissedByConversation,
    setDismissedByConversation,
  ] = useState<
    Record<
      string,
      string[]
    >
  >({});

  const dismissedSuggestions =
    dismissedByConversation[
      conversationKey
    ] ?? [];

  const heading =
    useMemo(() => {
      const index =
        hashString(
          conversationKey,
        ) %
        headings.length;

      return headings[
        index
      ];
    }, [
      conversationKey,
    ]);

  const suggestions =
    useMemo(() => {
      const index =
        (
          hashString(
            conversationKey,
          ) +
          3
        ) %
        suggestionGroups.length;

      return suggestionGroups[
        index
      ];
    }, [
      conversationKey,
    ]);

  const visibleSuggestions =
    suggestions.filter(
      (
        suggestion,
      ) =>
        !dismissedSuggestions.includes(
          suggestion.id,
        ),
    );

  function dismissSuggestion(
    id: string,
  ) {
    setDismissedByConversation(
      (
        current,
      ) => {
        const currentDismissed =
          current[
            conversationKey
          ] ?? [];

        if (
          currentDismissed.includes(
            id,
          )
        ) {
          return current;
        }

        return {
          ...current,

          [conversationKey]:
            [
              ...currentDismissed,
              id,
            ],
        };
      },
    );
  }

  return (
    <section className="relative flex min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[820px] flex-col justify-center px-5 pb-[15vh] pt-16 sm:px-8">
        {/* ============================================= */}
        {/* HEADING                                       */}
        {/* ============================================= */}

        <div className="mb-7 text-center">
          <h1
            className={cn(
              "text-[27px] font-medium tracking-[-0.035em] sm:text-[30px]",

              isDark
                ? "text-zinc-100"
                : "text-zinc-900",
            )}
          >
            {heading}
          </h1>
        </div>

        {/* ============================================= */}
        {/* REAL COMPOSER                                 */}
        {/* ============================================= */}

        {composer ? (
          <div className="w-full">
            {composer}
          </div>
        ) : null}

        {/* ============================================= */}
        {/* SUGGESTIONS                                   */}
        {/* ============================================= */}

        {visibleSuggestions.length >
        0 ? (
          <div className="mx-auto mt-4 w-full max-w-[760px]">
            {visibleSuggestions.map(
              (
                suggestion,
                index,
              ) => {
                const Icon =
                  suggestion.icon;

                return (
                  <div
                    key={
                      suggestion.id
                    }
                    className="group relative"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onSuggestionSelect(
                          suggestion.prompt,
                        )
                      }
                      className={cn(
                        "flex w-full items-center gap-3 rounded-[12px] py-3 pl-3 pr-11 text-left",

                        "transition-[background-color,transform] duration-150 ease-out",

                        "hover:translate-x-[2px]",

                        isDark
                          ? "text-zinc-300 hover:bg-white/[0.055] hover:text-white"
                          : "text-zinc-700 hover:bg-black/[0.045] hover:text-zinc-950",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center",

                          index ===
                          0
                            ? isDark
                              ? "text-blue-400"
                              : "text-blue-600"
                            : index ===
                                1
                              ? isDark
                                ? "text-violet-400"
                                : "text-violet-600"
                              : isDark
                                ? "text-emerald-400"
                                : "text-emerald-600",
                        )}
                      >
                        <Icon
                          size={
                            17
                          }
                        />
                      </span>

                      <span className="min-w-0 flex-1 text-[14px] leading-5">
                        {
                          suggestion.label
                        }
                      </span>
                    </button>

                    {/* ================================= */}
                    {/* DISMISS                           */}
                    {/* ================================= */}

                    <button
                      type="button"
                      aria-label="Dismiss suggestion"
                      title="Dismiss"
                      onClick={(
                        event,
                      ) => {
                        event.stopPropagation();

                        dismissSuggestion(
                          suggestion.id,
                        );
                      }}
                      className={cn(
                        "absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full",

                        "scale-90 opacity-0 transition-all duration-150",

                        "group-hover:scale-100 group-hover:opacity-100",

                        "group-focus-within:scale-100 group-focus-within:opacity-100",

                        isDark
                          ? "text-zinc-500 hover:bg-white/[0.09] hover:text-zinc-200"
                          : "text-zinc-400 hover:bg-black/[0.07] hover:text-zinc-900",
                      )}
                    >
                      <X
                        size={
                          14
                        }
                      />
                    </button>
                  </div>
                );
              },
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}