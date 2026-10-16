"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import {
  AnimatePresence,
  motion,
} from "framer-motion";

import {
  ChevronLeft,
  ChevronRight,
  FileSearch,
  FileText,
  Folder,
  Lightbulb,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Search,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";

import ClawbitMark from "@/components/brand/ClawbitMark";
import ProjectCommandBar from "@/components/projects/ProjectCommandBar";

import type { ChatSnapshot } from "@/hooks/useChat";
import type { Theme } from "@/lib/theme";

import { cn } from "@/lib/utils";

/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

interface ProjectConversation {
  id: string;
  title: string;
  preview: string;
  snapshot: ChatSnapshot;
  updatedAt: number;
}

interface ProjectFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  detail: string;
  preview?: string;
  kind: "document" | "image";
  uploadedAt: number;
}

interface UploadedProjectFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  detail: string;
  kind: "document" | "image";
}

interface ProjectOption {
  id: string;
  name: string;
}

export interface ProjectWorkspaceRecord {
  id: string;
  name: string;
  description: string;

  visibility:
    | "created"
    | "shared";

  createdAt: number;
  updatedAt: number;

  conversations: ProjectConversation[];
  files: ProjectFile[];
}

interface ProjectWorkspaceProps {
  theme: Theme;

  project:
    ProjectWorkspaceRecord;

  projects:
    ProjectOption[];

  loading:
    boolean;

  model:
    string;

  threadId:
    string;

  onModelChange: (
    model: string,
  ) => void;

  onStartChat: (
    prompt: string,
    attachmentIds?: string[],
  ) => Promise<void>;

  onOpenConversation: (
    conversation:
      ProjectConversation,
  ) => void;

  onChooseProject: (
    id: string,
  ) => void;

  onOpenTools:
    () => void;

  onFilesUploaded: (
    files:
      UploadedProjectFile[],
  ) => void;

  onRenameProject: (
    name: string,
  ) => void;

  onDeleteProject:
    () => void;
}

interface WorkSuggestion {
  id: string;

  icon: ComponentType<{
    size?: number;
    className?: string;
  }>;

  title: string;

  description: string;

  prompt: string;
}

/* ====================================================== */
/* SUGGESTIONS                                            */
/* ====================================================== */

const suggestionGroups:
  WorkSuggestion[][] = [
  [
    {
      id: "plan-project",

      icon: ListTodo,

      title:
        "Plan the project",

      description:
        "Turn the project goal into clear steps, priorities, and milestones.",

      prompt:
        "Review this project and create a clear step-by-step plan. Include priorities, milestones, risks, and the best next action.",
    },

    {
      id: "review-context",

      icon: FileSearch,

      title:
        "Review project context",

      description:
        "Summarize what is already here and surface the most important details.",

      prompt:
        "Review the current project context and summarize the important information, decisions, open questions, and anything I should know before continuing.",
    },

    {
      id: "next-steps",

      icon:
        WandSparkles,

      title:
        "Suggest next steps",

      description:
        "Find useful next actions based on the project description and work so far.",

      prompt:
        "Based on this project's goal and current progress, suggest the best next steps. Prioritize the actions that would move the project forward the most.",
    },
  ],

  [
    {
      id: "break-task",

      icon: ListTodo,

      title:
        "Break down a difficult task",

      description:
        "Turn a complex task into smaller steps that are easier to complete.",

      prompt:
        "Help me identify a difficult or complex part of this project and break it into small, practical steps I can complete one by one.",
    },

    {
      id: "find-gaps",

      icon: Search,

      title:
        "Find gaps and problems",

      description:
        "Look for missing information, weak areas, risks, or unfinished work.",

      prompt:
        "Review this project and identify important gaps, missing information, risks, weak areas, or unfinished work. Explain what should be fixed first.",
    },

    {
      id:
        "improve-project",

      icon:
        WandSparkles,

      title:
        "Improve the project",

      description:
        "Suggest improvements that would make the project stronger and more complete.",

      prompt:
        "Review this project and suggest practical improvements that would make it stronger, cleaner, more complete, and more useful.",
    },
  ],

  [
    {
      id:
        "project-summary",

      icon:
        FileText,

      title:
        "Create a project summary",

      description:
        "Create a clean overview of the goal, progress, context, and next actions.",

      prompt:
        "Create a concise project summary covering the goal, current progress, important context, completed work, remaining work, and next actions.",
    },

    {
      id: "priorities",

      icon: ListTodo,

      title:
        "Set today's priorities",

      description:
        "Choose the highest-value tasks to focus on right now.",

      prompt:
        "Based on this project, give me the highest-priority tasks I should focus on today. Keep the list practical and ordered by importance.",
    },

    {
      id: "brainstorm",

      icon:
        Lightbulb,

      title:
        "Brainstorm new ideas",

      description:
        "Generate useful ideas that fit the project's goal and direction.",

      prompt:
        "Brainstorm useful new ideas for this project. Keep them realistic, relevant to the project goal, and explain why each idea could help.",
    },
  ],
];

/* ====================================================== */
/* COMPONENT                                              */
/* ====================================================== */

export default function ProjectWorkspace({
  theme,

  project,

  projects,

  loading,

  model,

  threadId,

  onModelChange,

  onStartChat,

  onOpenConversation,

  onChooseProject,

  onOpenTools,

  onFilesUploaded,

  onRenameProject,

  onDeleteProject,
}: ProjectWorkspaceProps) {
  const isDark =
    theme === "dark";

  const [
    suggestionPage,
    setSuggestionPage,
  ] =
    useState(0);

  const [
    suggestionsVisible,
    setSuggestionsVisible,
  ] =
    useState(true);

  const [
    suggestionPrompt,
    setSuggestionPrompt,
  ] =
    useState("");

  const [
    openPanel,
    setOpenPanel,
  ] =
    useState<
      "files" | "chats" | null
    >(null);

  const [
    panelSearch,
    setPanelSearch,
  ] =
    useState("");

  const currentSuggestions =
    suggestionGroups[
      suggestionPage
    ];

  /* ==================================================== */
  /* AUTO ROTATE                                          */
  /* ==================================================== */

  useEffect(() => {
    if (
      !suggestionsVisible
    ) {
      return;
    }

    const timer =
      window.setTimeout(
        () => {
          setSuggestionPage(
            (
              current,
            ) =>
              current ===
              suggestionGroups.length -
                1
                ? 0
                : current +
                  1,
          );
        },

        5000,
      );

    return () =>
      window.clearTimeout(
        timer,
      );
  }, [
    suggestionPage,
    suggestionsVisible,
  ]);

  /* ==================================================== */
  /* FILTER                                               */
  /* ==================================================== */

  const filteredChats =
    useMemo(() => {
      const query =
        panelSearch
          .trim()
          .toLowerCase();

      if (!query) {
        return project.conversations;
      }

      return project.conversations.filter(
        (
          conversation,
        ) =>
          [
            conversation.title,
            conversation.preview,
          ]
            .join(" ")
            .toLowerCase()
            .includes(
              query,
            ),
      );
    }, [
      project.conversations,
      panelSearch,
    ]);

  const filteredFiles =
    useMemo(() => {
      const query =
        panelSearch
          .trim()
          .toLowerCase();

      if (!query) {
        return project.files;
      }

      return project.files.filter(
        (
          file,
        ) =>
          [
            file.name,
            file.detail,
            file.mimeType,
          ]
            .join(" ")
            .toLowerCase()
            .includes(
              query,
            ),
      );
    }, [
      project.files,
      panelSearch,
    ]);

  /* ==================================================== */
  /* ACTIONS                                              */
  /* ==================================================== */

  function renameProject() {
    const name =
      window.prompt(
        "Rename project",
        project.name,
      );

    if (
      !name?.trim()
    ) {
      return;
    }

    onRenameProject(
      name.trim(),
    );
  }

  function previousSuggestions() {
    setSuggestionPage(
      (
        current,
      ) =>
        current ===
        0
          ? suggestionGroups.length -
            1
          : current -
            1,
    );
  }

  function nextSuggestions() {
    setSuggestionPage(
      (
        current,
      ) =>
        current ===
        suggestionGroups.length -
          1
          ? 0
          : current +
            1,
    );
  }

  function handleSuggestion(
    promptText: string,
  ) {
    /*
     * Clear first so selecting
     * the same suggestion twice
     * still updates the command bar.
     */

    setSuggestionPrompt(
      "",
    );

    window.requestAnimationFrame(
      () => {
        setSuggestionPrompt(
          promptText,
        );
      },
    );
  }

  function showPanel(
    panel:
      | "files"
      | "chats",
  ) {
    setPanelSearch(
      "",
    );

    setOpenPanel(
      panel,
    );
  }

  /* ==================================================== */
  /* UI                                                   */
  /* ==================================================== */

  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full flex-col overflow-hidden",

        isDark
          ? "bg-black text-white"
          : "bg-[#fafafa] text-zinc-950",
      )}
    >
      {/* ============================================= */}
      {/* PROJECT HEADER                                */}
      {/* ============================================= */}

      <header
        className={cn(
          "shrink-0 border-b px-5 py-4 md:px-8 lg:px-10",

          isDark
            ? "border-white/[0.055]"
            : "border-black/[0.08]",
        )}
      >
        <div className="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-5">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border",

                isDark
                  ? "border-white/[0.08] bg-[#111111]"
                  : "border-black/[0.08] bg-white",
              )}
            >
              <Folder
                size={
                  17
                }
                strokeWidth={
                  1.8
                }
                className="text-zinc-500"
              />
            </div>

            <div className="min-w-0">
              <h1
                className={cn(
                  "truncate text-[15px] font-semibold tracking-[-0.025em]",

                  isDark
                    ? "text-white"
                    : "text-zinc-950",
                )}
              >
                {
                  project.name
                }
              </h1>

              <p
                className={cn(
                  "mt-0.5 max-w-[780px] truncate text-[11px]",

                  isDark
                    ? "text-zinc-600"
                    : "text-zinc-500",
                )}
              >
                {
                  project.description
                }
              </p>
            </div>
          </div>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              asChild
            >
              <button
                type="button"
                aria-label="Project options"
                title="Project options"
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-zinc-500 transition-colors",

                  isDark
                    ? "hover:bg-white/[0.06] hover:text-white"
                    : "hover:bg-black/[0.05] hover:text-black",
                )}
              >
                <MoreHorizontal
                  size={
                    18
                  }
                />
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={
                  7
                }
                collisionPadding={
                  12
                }
                className={cn(
                  "z-[1200] w-[180px] rounded-[14px] border p-1.5 shadow-[0_20px_55px_rgba(0,0,0,0.18)]",

                  isDark
                    ? "border-white/[0.09] bg-[#181818] text-white"
                    : "border-black/[0.10] bg-white text-zinc-950",
                )}
              >
                <DropdownMenu.Item
                  onSelect={
                    renameProject
                  }
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2.5 text-[12px] outline-none transition-colors",

                    isDark
                      ? "text-zinc-300 hover:bg-white/[0.07] focus:bg-white/[0.07] data-[highlighted]:bg-white/[0.07]"
                      : "text-zinc-700 hover:bg-black/[0.05] focus:bg-black/[0.05] data-[highlighted]:bg-black/[0.05]",
                  )}
                >
                  <Pencil
                    size={
                      15
                    }
                  />

                  Rename project
                </DropdownMenu.Item>

                <div
                  className={cn(
                    "my-1 border-t",

                    isDark
                      ? "border-white/[0.07]"
                      : "border-black/[0.08]",
                  )}
                />

                <DropdownMenu.Item
                  onSelect={
                    onDeleteProject
                  }
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2.5 text-[12px] outline-none transition-colors",

                    isDark
                      ? "text-red-400 hover:bg-red-500/[0.08] focus:bg-red-500/[0.08] data-[highlighted]:bg-red-500/[0.08]"
                      : "text-red-600 hover:bg-red-50 focus:bg-red-50 data-[highlighted]:bg-red-50",
                  )}
                >
                  <Trash2
                    size={
                      15
                    }
                  />

                  Delete project
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      {/* ============================================= */}
      {/* WORK AREA                                     */}
      {/* ============================================= */}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16 md:px-8">
        <main className="mx-auto w-full max-w-[900px]">
          {/* HERO */}

          <section className="pt-[125px] lg:pt-[150px] 2xl:pt-[175px]">
            <div className="flex items-center justify-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center">
                <ClawbitMark className="h-8 w-8" />
              </div>

              <h2
                className={cn(
                  "text-[26px] font-medium tracking-[-0.04em] sm:text-[28px]",

                  isDark
                    ? "text-white"
                    : "text-zinc-950",
                )}
              >
                What should we work on?
              </h2>
            </div>

            {/* COMMAND BAR */}

            <div className="mt-12">
              <ProjectCommandBar
                theme={
                  theme
                }

                projectId={
                  project.id
                }

                projectName={
                  project.name
                }

                projects={
                  projects
                }

                loading={
                  loading
                }

                model={
                  model
                }

                threadId={
                  threadId
                }

                initialPrompt={
                  suggestionPrompt
                }

                onModelChange={
                  onModelChange
                }

                onChooseProject={
                  onChooseProject
                }

                onOpenFiles={() =>
                  showPanel(
                    "files",
                  )
                }

                onOpenChats={() =>
                  showPanel(
                    "chats",
                  )
                }

                onOpenTools={
                  onOpenTools
                }

                onFilesUploaded={
                  onFilesUploaded
                }

                onSend={
                  onStartChat
                }
              />
            </div>
          </section>

          {/* ========================================= */}
          {/* SUGGESTIONS                               */}
          {/* ========================================= */}

          <AnimatePresence
            initial={
              false
            }
          >
            {suggestionsVisible ? (
              <motion.section
                initial={{
                  opacity:
                    0,

                  y:
                    8,
                }}
                animate={{
                  opacity:
                    1,

                  y:
                    0,
                }}
                exit={{
                  opacity:
                    0,

                  y:
                    -8,
                }}
                transition={{
                  duration:
                    0.2,
                }}
                className="mt-14"
              >
                <div className="mb-4 flex items-center justify-between gap-4 px-1">
                  <div className="flex items-center gap-2">
                    <Lightbulb
                      size={
                        15
                      }
                      className="text-zinc-500"
                    />

                    <h3
                      className={cn(
                        "text-[12px] font-medium",

                        isDark
                          ? "text-zinc-300"
                          : "text-zinc-700",
                      )}
                    >
                      See what Clawbit Work can do
                    </h3>
                  </div>

                  <div className="flex items-center gap-1">
                    <CarouselButton
                      theme={
                        theme
                      }
                      title="Previous"
                      onClick={
                        previousSuggestions
                      }
                    >
                      <ChevronLeft
                        size={
                          16
                        }
                      />
                    </CarouselButton>

                    <CarouselButton
                      theme={
                        theme
                      }
                      title="Next"
                      emphasized
                      onClick={
                        nextSuggestions
                      }
                    >
                      <ChevronRight
                        size={
                          16
                        }
                      />
                    </CarouselButton>

                    <CarouselButton
                      theme={
                        theme
                      }
                      title="Hide suggestions"
                      className="ml-1"
                      onClick={() =>
                        setSuggestionsVisible(
                          false,
                        )
                      }
                    >
                      <X
                        size={
                          15
                        }
                      />
                    </CarouselButton>
                  </div>
                </div>

                <div className="overflow-hidden">
                  <AnimatePresence
                    mode="wait"
                    initial={
                      false
                    }
                  >
                    <motion.div
                      key={
                        suggestionPage
                      }
                      initial={{
                        opacity:
                          0,

                        x:
                          30,
                      }}
                      animate={{
                        opacity:
                          1,

                        x:
                          0,
                      }}
                      exit={{
                        opacity:
                          0,

                        x:
                          -30,
                      }}
                      transition={{
                        duration:
                          0.28,

                        ease: [
                          0.16,
                          1,
                          0.3,
                          1,
                        ],
                      }}
                      className="grid grid-cols-1 gap-3 md:grid-cols-3"
                    >
                      {currentSuggestions.map(
                        (
                          suggestion,
                        ) => {
                          const Icon =
                            suggestion.icon;

                          return (
                            <button
                              key={
                                suggestion.id
                              }
                              type="button"
                              onClick={() =>
                                handleSuggestion(
                                  suggestion.prompt,
                                )
                              }
                              className={cn(
                                "group flex min-h-[150px] flex-col rounded-[18px] border p-4 text-left transition-colors",

                                isDark
                                  ? "border-white/[0.075] bg-[#111111] hover:border-white/[0.13] hover:bg-[#171717]"
                                  : "border-black/[0.085] bg-white hover:border-black/[0.14] hover:bg-[#fcfcfc]",
                              )}
                            >
                              <div className="flex items-start justify-between gap-4">
                                <div
                                  className={cn(
                                    "flex h-8 w-8 items-center justify-center rounded-[9px] border",

                                    isDark
                                      ? "border-white/[0.07] bg-[#1b1b1b]"
                                      : "border-black/[0.07] bg-[#f6f6f6]",
                                  )}
                                >
                                  <Icon
                                    size={
                                      15
                                    }
                                    className="text-zinc-500"
                                  />
                                </div>

                                <span
                                  className={cn(
                                    "rounded-full border px-2.5 py-1 text-[10px] transition-colors",

                                    isDark
                                      ? "border-white/[0.08] text-zinc-500 group-hover:text-zinc-300"
                                      : "border-black/[0.08] text-zinc-500 group-hover:text-zinc-800",
                                  )}
                                >
                                  Try
                                </span>
                              </div>

                              <p
                                className={cn(
                                  "mt-5 text-[13px] font-medium",

                                  isDark
                                    ? "text-zinc-200"
                                    : "text-zinc-900",
                                )}
                              >
                                {
                                  suggestion.title
                                }
                              </p>

                              <p className="mt-1.5 line-clamp-3 text-[11px] leading-[17px] text-zinc-500">
                                {
                                  suggestion.description
                                }
                              </p>
                            </button>
                          );
                        },
                      )}
                    </motion.div>
                  </AnimatePresence>
                </div>

                {/* DOTS */}

                <div className="mt-4 flex justify-center gap-1.5">
                  {suggestionGroups.map(
                    (
                      _,
                      index,
                    ) => (
                      <button
                        key={
                          index
                        }
                        type="button"
                        aria-label={`Show suggestion page ${
                          index +
                          1
                        }`}
                        onClick={() =>
                          setSuggestionPage(
                            index,
                          )
                        }
                        className={cn(
                          "h-1.5 rounded-full transition-all",

                          index ===
                          suggestionPage
                            ? isDark
                              ? "w-5 bg-zinc-400"
                              : "w-5 bg-zinc-600"
                            : isDark
                              ? "w-1.5 bg-zinc-800 hover:bg-zinc-600"
                              : "w-1.5 bg-zinc-300 hover:bg-zinc-400",
                        )}
                      />
                    ),
                  )}
                </div>
              </motion.section>
            ) : (
              <div className="mt-10 flex justify-center">
                <button
                  type="button"
                  onClick={() =>
                    setSuggestionsVisible(
                      true,
                    )
                  }
                  className={cn(
                    "rounded-full border px-4 py-2 text-[11px] transition-colors",

                    isDark
                      ? "border-white/[0.08] text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300"
                      : "border-black/[0.09] text-zinc-500 hover:bg-black/[0.04] hover:text-zinc-800",
                  )}
                >
                  Show suggestions
                </button>
              </div>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* ============================================= */}
      {/* FILES / CHATS PANEL                          */}
      {/* ============================================= */}

      <AnimatePresence>
        {openPanel ? (
          <>
            <motion.button
              type="button"
              aria-label="Close project panel"
              onClick={() =>
                setOpenPanel(
                  null,
                )
              }
              initial={{
                opacity:
                  0,
              }}
              animate={{
                opacity:
                  1,
              }}
              exit={{
                opacity:
                  0,
              }}
              className="fixed inset-0 z-[900] bg-black/45 backdrop-blur-[2px]"
            />

            <motion.div
              initial={{
                opacity:
                  0,

                y:
                  18,

                scale:
                  0.985,
              }}
              animate={{
                opacity:
                  1,

                y:
                  0,

                scale:
                  1,
              }}
              exit={{
                opacity:
                  0,

                y:
                  18,

                scale:
                  0.985,
              }}
              className={cn(
                "fixed left-1/2 top-1/2 z-[901] flex max-h-[70vh] w-[min(92vw,620px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] border shadow-[0_30px_90px_rgba(0,0,0,0.25)]",

                isDark
                  ? "border-white/[0.09] bg-[#181818] text-white"
                  : "border-black/[0.10] bg-white text-zinc-950",
              )}
            >
              {/* HEADER */}

              <div
                className={cn(
                  "flex items-center justify-between border-b px-5 py-4",

                  isDark
                    ? "border-white/[0.07]"
                    : "border-black/[0.08]",
                )}
              >
                <div>
                  <p
                    className={cn(
                      "text-[14px] font-medium",

                      isDark
                        ? "text-white"
                        : "text-zinc-950",
                    )}
                  >
                    {openPanel ===
                    "files"
                      ? "Project files"
                      : "Project chats"}
                  </p>

                  <p className="mt-1 text-[10px] text-zinc-500">
                    {openPanel ===
                    "files"
                      ? `${project.files.length} files in ${project.name}`
                      : `${project.conversations.length} chats in ${project.name}`}
                  </p>
                </div>

                <button
                  type="button"
                  aria-label="Close"
                  onClick={() =>
                    setOpenPanel(
                      null,
                    )
                  }
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-[9px] text-zinc-500 transition-colors",

                    isDark
                      ? "hover:bg-white/[0.07] hover:text-white"
                      : "hover:bg-black/[0.05] hover:text-black",
                  )}
                >
                  <X
                    size={
                      16
                    }
                  />
                </button>
              </div>

              {/* SEARCH */}

              <div className="px-4 pt-4">
                <div
                  className={cn(
                    "flex h-10 items-center gap-2 rounded-[11px] border px-3",

                    isDark
                      ? "border-white/[0.09] bg-[#0d0d0d] focus-within:border-white/[0.16]"
                      : "border-black/[0.10] bg-white focus-within:border-black/[0.18]",
                  )}
                >
                  <Search
                    size={
                      14
                    }
                    className="text-zinc-500"
                  />

                  <input
                    value={
                      panelSearch
                    }
                    onChange={(
                      event,
                    ) =>
                      setPanelSearch(
                        event.target
                          .value,
                      )
                    }
                    placeholder={
                      openPanel ===
                      "files"
                        ? "Search files"
                        : "Search chats"
                    }
                    className={cn(
                      "min-w-0 flex-1 border-0 bg-transparent text-[12px] outline-none shadow-none",

                      isDark
                        ? "text-zinc-200 placeholder:text-zinc-600"
                        : "text-zinc-900 placeholder:text-zinc-400",
                    )}
                  />

                  {panelSearch ? (
                    <button
                      type="button"
                      aria-label="Clear search"
                      onClick={() =>
                        setPanelSearch(
                          "",
                        )
                      }
                      className={cn(
                        "flex h-6 w-6 items-center justify-center rounded-full text-zinc-500",

                        isDark
                          ? "hover:bg-white/[0.07] hover:text-white"
                          : "hover:bg-black/[0.05] hover:text-black",
                      )}
                    >
                      <X
                        size={
                          12
                        }
                      />
                    </button>
                  ) : null}
                </div>
              </div>

              {/* CONTENT */}

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {openPanel ===
                "files" ? (
                  filteredFiles.length >
                  0 ? (
                    <div className="space-y-1">
                      {filteredFiles.map(
                        (
                          file,
                        ) => (
                          <div
                            key={
                              file.id
                            }
                            className={cn(
                              "flex items-center gap-3 rounded-[11px] px-3 py-3 transition-colors",

                              isDark
                                ? "hover:bg-white/[0.045]"
                                : "hover:bg-black/[0.035]",
                            )}
                          >
                            <div
                              className={cn(
                                "flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border",

                                isDark
                                  ? "border-white/[0.06] bg-[#202020]"
                                  : "border-black/[0.07] bg-[#f5f5f5]",
                              )}
                            >
                              <FileText
                                size={
                                  15
                                }
                                className="text-zinc-500"
                              />
                            </div>

                            <div className="min-w-0 flex-1">
                              <p
                                className={cn(
                                  "truncate text-[12px]",

                                  isDark
                                    ? "text-zinc-300"
                                    : "text-zinc-800",
                                )}
                              >
                                {
                                  file.name
                                }
                              </p>

                              <p className="mt-1 truncate text-[10px] text-zinc-500">
                                {
                                  file.detail
                                }
                              </p>
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  ) : (
                    <PanelEmpty
                      theme={
                        theme
                      }
                      icon={
                        Paperclip
                      }
                      title="No project files yet"
                      description="Use the + button in the command bar to add files."
                    />
                  )
                ) : filteredChats.length >
                  0 ? (
                  <div className="space-y-1">
                    {filteredChats.map(
                      (
                        conversation,
                      ) => (
                        <button
                          key={
                            conversation.id
                          }
                          type="button"
                          onClick={() => {
                            setOpenPanel(
                              null,
                            );

                            onOpenConversation(
                              conversation,
                            );
                          }}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-[11px] px-3 py-3 text-left transition-colors",

                            isDark
                              ? "hover:bg-white/[0.045]"
                              : "hover:bg-black/[0.035]",
                          )}
                        >
                          <div
                            className={cn(
                              "flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border",

                              isDark
                                ? "border-white/[0.06] bg-[#202020]"
                                : "border-black/[0.07] bg-[#f5f5f5]",
                            )}
                          >
                            <MessageSquare
                              size={
                                15
                              }
                              className="text-zinc-500"
                            />
                          </div>

                          <div className="min-w-0 flex-1">
                            <p
                              className={cn(
                                "truncate text-[12px] font-medium",

                                isDark
                                  ? "text-zinc-300"
                                  : "text-zinc-800",
                              )}
                            >
                              {
                                conversation.title
                              }
                            </p>

                            <p className="mt-1 truncate text-[10px] text-zinc-500">
                              {
                                conversation.preview
                              }
                            </p>
                          </div>
                        </button>
                      ),
                    )}
                  </div>
                ) : (
                  <PanelEmpty
                    theme={
                      theme
                    }
                    icon={
                      MessageSquare
                    }
                    title="No project chats yet"
                    description="Start a task from the command bar and it will appear here."
                  />
                )}
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ====================================================== */
/* CAROUSEL BUTTON                                        */
/* ====================================================== */

function CarouselButton({
  theme,
  title,
  children,
  onClick,
  emphasized = false,
  className,
}: {
  theme:
    Theme;

  title:
    string;

  children:
    React.ReactNode;

  onClick:
    () => void;

  emphasized?:
    boolean;

  className?:
    string;
}) {
  const isDark =
    theme === "dark";

  return (
    <button
      type="button"
      onClick={
        onClick
      }
      aria-label={
        title
      }
      title={
        title
      }
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-full transition-colors",

        emphasized
          ? isDark
            ? "bg-[#202020] text-zinc-300 hover:bg-[#292929] hover:text-white"
            : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300 hover:text-black"
          : isDark
            ? "text-zinc-500 hover:bg-white/[0.07] hover:text-white"
            : "text-zinc-500 hover:bg-black/[0.05] hover:text-black",

        className,
      )}
    >
      {
        children
      }
    </button>
  );
}

/* ====================================================== */
/* EMPTY PANEL                                            */
/* ====================================================== */

function PanelEmpty({
  theme,
  icon: Icon,
  title,
  description,
}: {
  theme:
    Theme;

  icon:
    ComponentType<{
      size?: number;
      className?: string;
    }>;

  title:
    string;

  description:
    string;
}) {
  const isDark =
    theme === "dark";

  return (
    <div className="flex min-h-[230px] flex-col items-center justify-center text-center">
      <div
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-[12px] border",

          isDark
            ? "border-white/[0.07] bg-[#202020]"
            : "border-black/[0.08] bg-[#f5f5f5]",
        )}
      >
        <Icon
          size={
            17
          }
          className="text-zinc-500"
        />
      </div>

      <p
        className={cn(
          "mt-4 text-[12px] font-medium",

          isDark
            ? "text-zinc-300"
            : "text-zinc-800",
        )}
      >
        {
          title
        }
      </p>

      <p className="mt-2 max-w-[300px] text-[10px] leading-5 text-zinc-500">
        {
          description
        }
      </p>
    </div>
  );
}
