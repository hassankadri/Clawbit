"use client";

import {
  Calculator,
  CalendarClock,
  ChevronRight,
  CloudSun,
  Database,
  FileSearch,
  Globe2,
  LineChart,
  MemoryStick,
  Search,
  Telescope,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  useMemo,
  useState,
} from "react";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

type ToolCategory =
  | "all"
  | "built-in"
  | "research";

interface ToolDefinition {
  id: string;

  name: string;

  backendName: string;

  description: string;

  details: string;

  category:
    | "built-in"
    | "research";

  icon: LucideIcon;
}

/* ====================================================== */
/* REAL CLAWBIT TOOLS                                     */
/* ====================================================== */

const tools: ToolDefinition[] = [
  {
    id: "document-search",

    name: "Document search",

    backendName:
      "search_uploaded_documents",

    description:
      "Search uploaded PDFs, documents, notes and project files.",

    details:
      "Clawbit uses this tool when a question needs information from files you uploaded. Relevant document chunks are retrieved and passed back to the model.",

    category:
      "built-in",

    icon: FileSearch,
  },

  {
    id: "web-search",

    name: "Web search",

    backendName:
      "web_search",

    description:
      "Search the web for current or changing information.",

    details:
      "Used for recent information such as news, software updates, current events and other information that may have changed.",

    category:
      "built-in",

    icon: Globe2,
  },

  {
    id: "calculator",

    name: "Calculator",

    backendName:
      "calculator",

    description:
      "Perform reliable mathematical calculations.",

    details:
      "Used for arithmetic, percentages, formulas and other calculations instead of asking the language model to calculate everything itself.",

    category:
      "built-in",

    icon: Calculator,
  },

  {
    id: "memory-save",

    name: "Save memory",

    backendName:
      "remember_this",

    description:
      "Save information into Clawbit's workspace memory.",

    details:
      "Used when information should be stored in long-term workspace memory and made available to later conversations.",

    category:
      "built-in",

    icon: MemoryStick,
  },

  {
    id: "memory-recall",

    name: "Recall memory",

    backendName:
      "recall_memory",

    description:
      "Search information previously stored in workspace memory.",

    details:
      "Lets Clawbit retrieve relevant saved context when earlier workspace information is useful for the current request.",

    category:
      "built-in",

    icon: Database,
  },

  {
    id: "weather",

    name: "Weather",

    backendName:
      "get_weather",

    description:
      "Retrieve current weather information for a location.",

    details:
      "Clawbit can use web-backed weather information instead of relying on static model knowledge.",

    category:
      "built-in",

    icon: CloudSun,
  },

  {
    id: "stock",

    name: "Stock lookup",

    backendName:
      "get_stock_price",

    description:
      "Retrieve current stock-market information.",

    details:
      "Looks up recent stock prices and market information using the backend's web-search capability.",

    category:
      "built-in",

    icon: LineChart,
  },

  {
    id: "webpage",

    name: "Read webpage",

    backendName:
      "read_webpage",

    description:
      "Read text content from a webpage URL.",

    details:
      "Useful when you provide a webpage and want Clawbit to read, explain or summarize its contents.",

    category:
      "built-in",

    icon: Globe2,
  },

  {
    id: "datetime",

    name: "Date & time",

    backendName:
      "current_datetime",

    description:
      "Get the current date and time.",

    details:
      "Provides current date and time information directly from the backend environment.",

    category:
      "built-in",

    icon: CalendarClock,
  },

  {
    id: "research-search",

    name: "Research web search",

    backendName:
      "research_web_search",

    description:
      "Deeper web searching used while Research Mode is active.",

    details:
      "Research Mode uses a specialized web-search tool designed to collect compact source information across multiple searches.",

    category:
      "research",

    icon: Telescope,
  },
];

/* ====================================================== */
/* TABS                                                   */
/* ====================================================== */

const tabs: Array<{
  id: ToolCategory;
  label: string;
}> = [
  {
    id: "all",
    label: "All",
  },

  {
    id: "built-in",
    label: "Built-in",
  },

  {
    id: "research",
    label: "Research",
  },
];

/* ====================================================== */
/* COMPONENT                                              */
/* ====================================================== */

export default function ToolsWorkspace({
  theme,
}: {
  theme: Theme;
}) {
  const isDark =
    theme === "dark";

  const [
    activeTab,
    setActiveTab,
  ] = useState<ToolCategory>(
    "all",
  );

  const [
    search,
    setSearch,
  ] = useState("");

  const [
    selectedTool,
    setSelectedTool,
  ] = useState<ToolDefinition | null>(
    null,
  );

  /* ==================================================== */
  /* FILTERING                                            */
  /* ==================================================== */

  const filteredTools =
    useMemo(() => {
      const query =
        search
          .trim()
          .toLowerCase();

      return tools.filter(
        (tool) => {
          if (
            activeTab !==
              "all" &&
            tool.category !==
              activeTab
          ) {
            return false;
          }

          if (!query) {
            return true;
          }

          return [
            tool.name,
            tool.backendName,
            tool.description,
            tool.details,
          ]
            .join(" ")
            .toLowerCase()
            .includes(
              query,
            );
        },
      );
    }, [
      activeTab,
      search,
    ]);

  const builtInCount =
    tools.filter(
      (tool) =>
        tool.category ===
        "built-in",
    ).length;

  const researchCount =
    tools.filter(
      (tool) =>
        tool.category ===
        "research",
    ).length;

  /* ==================================================== */
  /* UI                                                   */
  /* ==================================================== */

  return (
    <div
      className={cn(
        "h-full min-h-0 overflow-y-auto",

        isDark
          ? "bg-black text-white"
          : "bg-[#fafafa] text-zinc-950",
      )}
    >
      <div className="mx-auto w-full max-w-[1160px] px-6 pb-20 pt-10 lg:px-10">
        {/* ============================================== */}
        {/* HEADER                                         */}
        {/* ============================================== */}

        <div className="flex flex-col gap-6 border-b border-white/[0.07] pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.04em]">
              Tools
            </h1>

            <p className="mt-2 max-w-[620px] text-[13px] leading-6 text-zinc-500">
              Capabilities Clawbit can use while working on your requests.
            </p>
          </div>

          {/* SEARCH */}

          <div
            className={cn(
              "flex h-10 w-full items-center gap-2 rounded-full border px-4 sm:w-[280px]",

              isDark
                ? "border-white/[0.09] bg-[#0d0d0d]"
                : "border-black/[0.10] bg-white",
            )}
          >
            <Search
              size={15}
              className="shrink-0 text-zinc-500"
            />

            <input
              value={
                search
              }
              onChange={(
                event,
              ) =>
                setSearch(
                  event.target
                    .value,
                )
              }
              placeholder="Search tools"
              className="min-w-0 flex-1 border-0 bg-transparent text-[12px] outline-none placeholder:text-zinc-600"
            />

            {search ? (
              <button
                type="button"
                onClick={() =>
                  setSearch(
                    "",
                  )
                }
                aria-label="Clear search"
                className="flex h-6 w-6 items-center justify-center rounded-full text-zinc-600 hover:bg-white/[0.07] hover:text-white"
              >
                <X
                  size={12}
                />
              </button>
            ) : null}
          </div>
        </div>

        {/* ============================================== */}
        {/* TABS                                           */}
        {/* ============================================== */}

        <div className="mt-6 flex items-center gap-1">
          {tabs.map(
            (tab) => {
              const active =
                tab.id ===
                activeTab;

              const count =
                tab.id ===
                "all"
                  ? tools.length
                  : tab.id ===
                      "built-in"
                    ? builtInCount
                    : researchCount;

              return (
                <button
                  key={
                    tab.id
                  }
                  type="button"
                  onClick={() =>
                    setActiveTab(
                      tab.id,
                    )
                  }
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-[10px] px-3 text-[12px] transition-colors",

                    active
                      ? isDark
                        ? "bg-[#232323] text-white"
                        : "bg-black/[0.07] text-black"
                      : "text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200",
                  )}
                >
                  {
                    tab.label
                  }

                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[9px]",

                      active
                        ? "bg-white/[0.08] text-zinc-300"
                        : "bg-white/[0.04] text-zinc-600",
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            },
          )}
        </div>

        {/* ============================================== */}
        {/* TOOL GRID                                      */}
        {/* ============================================== */}

        {filteredTools.length >
        0 ? (
          <div className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredTools.map(
              (tool) => {
                const Icon =
                  tool.icon;

                return (
                  <button
                    key={
                      tool.id
                    }
                    type="button"
                    onClick={() =>
                      setSelectedTool(
                        tool,
                      )
                    }
                    className={cn(
                      "group flex min-h-[165px] flex-col rounded-[18px] border p-4 text-left transition-all",

                      isDark
                        ? "border-white/[0.075] bg-[#151515] hover:border-white/[0.14] hover:bg-[#1b1b1b]"
                        : "border-black/[0.08] bg-white hover:border-black/[0.16]",
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-[10px] border",

                          isDark
                            ? "border-white/[0.07] bg-[#202020]"
                            : "border-black/[0.06] bg-zinc-100",
                        )}
                      >
                        <Icon
                          size={16}
                          className="text-zinc-400"
                        />
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />

                        <span className="text-[9px] font-medium text-zinc-500">
                          Available
                        </span>
                      </div>
                    </div>

                    <div className="mt-5 flex flex-1 flex-col">
                      <p className="text-[13px] font-medium text-zinc-200">
                        {
                          tool.name
                        }
                      </p>

                      <p className="mt-1.5 line-clamp-2 text-[11px] leading-[18px] text-zinc-500">
                        {
                          tool.description
                        }
                      </p>

                      <div className="mt-auto flex items-center justify-between pt-5">
                        <span className="font-mono text-[9px] text-zinc-700">
                          {
                            tool.backendName
                          }
                        </span>

                        <ChevronRight
                          size={14}
                          className="text-zinc-700 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-400"
                        />
                      </div>
                    </div>
                  </button>
                );
              },
            )}
          </div>
        ) : (
          <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-white/[0.07] bg-[#151515]">
              <Search
                size={17}
                className="text-zinc-600"
              />
            </div>

            <p className="mt-4 text-[13px] font-medium text-zinc-300">
              No tools found
            </p>

            <p className="mt-1.5 text-[11px] text-zinc-600">
              Try another search or category.
            </p>
          </div>
        )}
      </div>

      {/* ================================================= */}
      {/* TOOL DETAILS                                     */}
      {/* ================================================= */}

      {selectedTool ? (
        <>
          <button
            type="button"
            aria-label="Close tool details"
            onClick={() =>
              setSelectedTool(
                null,
              )
            }
            className="fixed inset-0 z-[1000] bg-black/55 backdrop-blur-[2px]"
          />

          <div className="fixed left-1/2 top-1/2 z-[1001] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border border-white/[0.09] bg-[#171717] p-5 shadow-[0_30px_100px_rgba(0,0,0,0.75)]">
            <div className="flex items-start justify-between gap-5">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] border border-white/[0.07] bg-[#222222]">
                  <selectedTool.icon
                    size={17}
                    className="text-zinc-300"
                  />
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[15px] font-medium">
                      {
                        selectedTool.name
                      }
                    </h2>

                    <span className="flex items-center gap-1 rounded-full border border-emerald-500/15 bg-emerald-500/[0.06] px-2 py-0.5 text-[9px] text-emerald-400">
                      <span className="h-1 w-1 rounded-full bg-emerald-400" />

                      Available
                    </span>
                  </div>

                  <p className="mt-1 font-mono text-[10px] text-zinc-600">
                    {
                      selectedTool.backendName
                    }
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  setSelectedTool(
                    null,
                  )
                }
                aria-label="Close"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-zinc-500 hover:bg-white/[0.07] hover:text-white"
              >
                <X
                  size={15}
                />
              </button>
            </div>

            <div className="mt-5 border-t border-white/[0.07] pt-5">
              <p className="text-[11px] font-medium text-zinc-400">
                What it does
              </p>

              <p className="mt-2 text-[12px] leading-6 text-zinc-500">
                {
                  selectedTool.details
                }
              </p>
            </div>

            <div className="mt-5 flex items-center justify-between rounded-[12px] border border-white/[0.06] bg-[#101010] px-3 py-3">
              <div>
                <p className="text-[10px] text-zinc-600">
                  Type
                </p>

                <p className="mt-1 text-[11px] text-zinc-300">
                  {selectedTool.category ===
                  "research"
                    ? "Research tool"
                    : "Built-in tool"}
                </p>
              </div>

              <div className="text-right">
                <p className="text-[10px] text-zinc-600">
                  Status
                </p>

                <p className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />

                  Available
                </p>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}