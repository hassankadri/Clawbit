"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import {
  Check,
  ChevronDown,
  Clock3,
  Folder,
  FolderPlus,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import {
  useMemo,
  useState,
  type ComponentType,
} from "react";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface ProjectConversation {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
}

interface ProjectFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  detail: string;
  preview?: string;

  kind:
    | "document"
    | "image";

  uploadedAt: number;
}

export interface ProjectRecord {
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

type ProjectSort =
  | "newest"
  | "oldest"
  | "name-asc"
  | "name-desc";

interface ProjectsWorkspaceProps {
  theme: Theme;

  projects: ProjectRecord[];

  activeProjectId:
    | string
    | null;

  onCreateProject: (
    name: string,
    description: string,
  ) => string;

  onRenameProject: (
    id: string,
    name: string,
  ) => void;

  onDeleteProject: (
    id: string,
  ) => void;

  onOpenProject: (
    id: string,
  ) => void;
}

const sortOptions: Array<{
  id: ProjectSort;
  label: string;
}> = [
  {
    id: "newest",
    label: "Newest",
  },
  {
    id: "oldest",
    label: "Oldest",
  },
  {
    id: "name-asc",
    label: "Name A–Z",
  },
  {
    id: "name-desc",
    label: "Name Z–A",
  },
];

export default function ProjectsWorkspace({
  theme,
  projects,
  activeProjectId,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onOpenProject,
}: ProjectsWorkspaceProps) {
  const isDark =
    theme === "dark";

  const [
    search,
    setSearch,
  ] = useState("");

  const [
    sort,
    setSort,
  ] = useState<ProjectSort>(
    "newest",
  );

  const [
    createOpen,
    setCreateOpen,
  ] = useState(false);

  const [
    projectName,
    setProjectName,
  ] = useState("");

  const [
    projectDescription,
    setProjectDescription,
  ] = useState("");

  const [
    creating,
    setCreating,
  ] = useState(false);

  const filteredProjects =
    useMemo(() => {
      const query =
        search
          .trim()
          .toLowerCase();

      const result =
        projects.filter(
          (project) => {
            if (!query) {
              return true;
            }

            const searchable =
              [
                project.name,
                project.description,

                ...project.conversations.map(
                  (
                    conversation,
                  ) =>
                    conversation.title,
                ),

                ...project.files.map(
                  (file) =>
                    file.name,
                ),
              ]
                .join(" ")
                .toLowerCase();

            return searchable.includes(
              query,
            );
          },
        );

      return [
        ...result,
      ].sort(
        (left, right) => {
          switch (sort) {
            case "oldest":
              return (
                left.updatedAt -
                right.updatedAt
              );

            case "name-asc":
              return left.name.localeCompare(
                right.name,
              );

            case "name-desc":
              return right.name.localeCompare(
                left.name,
              );

            default:
              return (
                right.updatedAt -
                left.updatedAt
              );
          }
        },
      );
    }, [
      projects,
      search,
      sort,
    ]);

  const currentSort =
    sortOptions.find(
      (item) =>
        item.id === sort,
    )?.label ?? "Newest";

  function resetCreateForm() {
    setProjectName("");

    setProjectDescription(
      "",
    );
  }

  function openCreateDialog() {
    resetCreateForm();

    setCreateOpen(
      true,
    );
  }

  function closeCreateDialog() {
    if (creating) {
      return;
    }

    resetCreateForm();

    setCreateOpen(
      false,
    );
  }

  function createProject() {
    const name =
      projectName.trim();

    const description =
      projectDescription.trim();

    if (
      !name ||
      !description
    ) {
      return;
    }

    setCreating(
      true,
    );

    try {
      const projectId =
        onCreateProject(
          name,
          description,
        );

      resetCreateForm();

      setCreateOpen(
        false,
      );

      if (projectId) {
        onOpenProject(
          projectId,
        );
      }
    } finally {
      setCreating(
        false,
      );
    }
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full flex-col overflow-hidden",

        isDark
          ? "bg-black text-white"
          : "bg-[#fafafa] text-zinc-950",
      )}
    >
      {/* HEADER */}

      <div className="shrink-0 px-5 pt-7 md:px-8 lg:px-10">
        <div className="mx-auto w-full max-w-[1450px]">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <h1 className="text-[27px] font-semibold tracking-[-0.04em]">
                Projects
              </h1>

              <p className="mt-2 max-w-[580px] text-[13px] leading-5 text-zinc-500">
                Keep related chats, files and context together in one focused
                workspace.
              </p>
            </div>

            <button
              type="button"
              onClick={
                openCreateDialog
              }
              className={cn(
                "flex h-10 shrink-0 items-center justify-center gap-2 rounded-full px-4 text-[13px] font-medium transition-colors",

                isDark
                  ? "bg-white text-black hover:bg-zinc-200"
                  : "bg-black text-white hover:bg-zinc-800",
              )}
            >
              <Plus
                size={
                  15
                }
              />

              New project
            </button>
          </div>

          {/* TOOLBAR */}

          <div className="mt-7 flex flex-col gap-3 border-b border-white/[0.06] pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div
              className={cn(
                "flex h-10 w-full max-w-[360px] items-center gap-2 rounded-full border px-3",

                isDark
                  ? "border-white/[0.12] bg-black focus-within:border-white/[0.25]"
                  : "border-black/[0.12] bg-white focus-within:border-black/[0.25]",
              )}
            >
              <Search
                size={
                  16
                }
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
                    event.target.value,
                  )
                }
                placeholder="Search projects"
                autoComplete="off"
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] outline-none shadow-none placeholder:text-zinc-600 focus:outline-none focus-visible:shadow-none"
                style={{
                  boxShadow:
                    "none",
                }}
              />

              {search ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() =>
                    setSearch(
                      "",
                    )
                  }
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-white/[0.07] hover:text-white"
                >
                  <X
                    size={
                      13
                    }
                  />
                </button>
              ) : null}
            </div>

            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                asChild
              >
                <button
                  type="button"
                  className={cn(
                    "flex h-10 min-w-[120px] items-center justify-between gap-3 rounded-full border px-4 text-[12px]",

                    isDark
                      ? "border-white/[0.12] bg-black text-zinc-300 hover:bg-[#171717]"
                      : "border-black/[0.12] bg-white text-zinc-700 hover:bg-zinc-100",
                  )}
                >
                  <span>
                    {
                      currentSort
                    }
                  </span>

                  <ChevronDown
                    size={
                      14
                    }
                    className="text-zinc-500"
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
                    "z-[1200] w-[170px] rounded-[14px] border p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.65)]",

                    isDark
                      ? "border-white/[0.09] bg-[#202020]"
                      : "border-black/[0.10] bg-white",
                  )}
                >
                  {sortOptions.map(
                    (
                      option,
                    ) => {
                      const active =
                        sort ===
                        option.id;

                      return (
                        <DropdownMenu.Item
                          key={
                            option.id
                          }
                          onSelect={() =>
                            setSort(
                              option.id,
                            )
                          }
                          className={cn(
                            "flex cursor-pointer items-center justify-between rounded-[9px] px-3 py-2.5 text-[12px] outline-none",

                            isDark
                              ? "text-zinc-300 hover:bg-[#303030] focus:bg-[#303030]"
                              : "text-zinc-700 hover:bg-zinc-100 focus:bg-zinc-100",
                          )}
                        >
                          {
                            option.label
                          }

                          {active ? (
                            <Check
                              size={
                                14
                              }
                            />
                          ) : null}
                        </DropdownMenu.Item>
                      );
                    },
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      </div>

      {/* PROJECT CARDS */}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-12 pt-7 md:px-8 lg:px-10">
        <div className="mx-auto w-full max-w-[1450px]">
          {filteredProjects.length >
          0 ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {filteredProjects.map(
                (
                  project,
                ) => (
                  <ProjectCard
                    key={
                      project.id
                    }
                    project={
                      project
                    }
                    active={
                      activeProjectId ===
                      project.id
                    }
                    theme={
                      theme
                    }
                    onOpen={() =>
                      onOpenProject(
                        project.id,
                      )
                    }
                    onRename={(
                      name,
                    ) =>
                      onRenameProject(
                        project.id,
                        name,
                      )
                    }
                    onDelete={() =>
                      onDeleteProject(
                        project.id,
                      )
                    }
                  />
                ),
              )}
            </div>
          ) : (
            <ProjectsEmptyState
              search={
                search
              }
              onClearSearch={() =>
                setSearch(
                  "",
                )
              }
              onCreate={
                openCreateDialog
              }
            />
          )}
        </div>
      </div>

      {/* CREATE PROJECT */}

      <Dialog.Root
        open={
          createOpen
        }
        onOpenChange={(
          open,
        ) => {
          if (open) {
            setCreateOpen(
              true,
            );
          } else {
            closeCreateDialog();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[1000] bg-black/65 backdrop-blur-sm" />

          <Dialog.Content
            className={cn(
              "fixed left-1/2 top-1/2 z-[1001] w-[min(92vw,500px)] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border p-5 shadow-[0_30px_90px_rgba(0,0,0,0.7)] outline-none",

              isDark
                ? "border-white/[0.09] bg-[#202020]"
                : "border-black/[0.10] bg-white",
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-[17px] font-semibold tracking-[-0.025em]">
                  Create a project
                </Dialog.Title>

                <Dialog.Description className="mt-1.5 text-[12px] leading-5 text-zinc-500">
                  Give your workspace a name and explain what you will use it
                  for.
                </Dialog.Description>
              </div>

              <Dialog.Close
                asChild
              >
                <button
                  type="button"
                  aria-label="Close"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-zinc-500 hover:bg-white/[0.07] hover:text-white"
                >
                  <X
                    size={
                      16
                    }
                  />
                </button>
              </Dialog.Close>
            </div>

            {/* NAME */}

            <div className="mt-6">
              <label
                htmlFor="project-name-input"
                className="text-[12px] font-medium text-zinc-300"
              >
                Project name
              </label>

              <div className="relative mt-2">
                <Folder
                  size={
                    16
                  }
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500"
                />

                <input
                  id="project-name-input"
                  autoFocus
                  value={
                    projectName
                  }
                  onChange={(
                    event,
                  ) =>
                    setProjectName(
                      event.target.value,
                    )
                  }
                  maxLength={
                    80
                  }
                  placeholder="e.g. Clawbit AI"
                  autoComplete="off"
                  className={cn(
                    "h-12 w-full rounded-[12px] border py-0 pl-10 pr-3 text-[13px] outline-none shadow-none focus-visible:shadow-none",

                    isDark
                      ? "border-white/[0.10] bg-[#111111] text-white placeholder:text-zinc-600 focus:border-white/[0.22]"
                      : "border-black/[0.12] bg-white text-black placeholder:text-zinc-400 focus:border-black/[0.25]",
                  )}
                  style={{
                    boxShadow:
                      "none",
                  }}
                />
              </div>
            </div>

            {/* DESCRIPTION */}

            <div className="mt-5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="project-description-input"
                  className="text-[12px] font-medium text-zinc-300"
                >
                  Description
                </label>

                <span className="text-[10px] text-zinc-600">
                  {
                    projectDescription.length
                  }
                  /280
                </span>
              </div>

              <textarea
                id="project-description-input"
                value={
                  projectDescription
                }
                onChange={(
                  event,
                ) =>
                  setProjectDescription(
                    event.target.value,
                  )
                }
                maxLength={
                  280
                }
                rows={
                  4
                }
                placeholder="Describe what you want to work on in this project..."
                className={cn(
                  "mt-2 w-full resize-none rounded-[12px] border px-3.5 py-3 text-[13px] leading-5 outline-none shadow-none focus-visible:shadow-none",

                  isDark
                    ? "border-white/[0.10] bg-[#111111] text-white placeholder:text-zinc-600 focus:border-white/[0.22]"
                    : "border-black/[0.12] bg-white text-black placeholder:text-zinc-400 focus:border-black/[0.25]",
                )}
                style={{
                  boxShadow:
                    "none",
                }}
              />
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close
                asChild
              >
                <button
                  type="button"
                  className="h-10 rounded-[10px] px-4 text-[13px] text-zinc-400 hover:bg-white/[0.06] hover:text-white"
                >
                  Cancel
                </button>
              </Dialog.Close>

              <button
                type="button"
                disabled={
                  !projectName.trim() ||
                  !projectDescription.trim() ||
                  creating
                }
                onClick={
                  createProject
                }
                className="h-10 rounded-[10px] bg-white px-4 text-[13px] font-medium text-black hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Create project
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function ProjectCard({
  project,
  active,
  theme,
  onOpen,
  onRename,
  onDelete,
}: {
  project: ProjectRecord;
  active: boolean;
  theme: Theme;
  onOpen: () => void;

  onRename: (
    name: string,
  ) => void;

  onDelete: () => void;
}) {
  const isDark =
    theme === "dark";

  function renameProject() {
    const nextName =
      window.prompt(
        "Rename project",
        project.name,
      );

    if (
      !nextName?.trim()
    ) {
      return;
    }

    onRename(
      nextName.trim(),
    );
  }

  function deleteProject() {
    const confirmed =
      window.confirm(
        `Delete "${project.name}"?\n\nIts project chats and project metadata will be removed.`,
      );

    if (
      !confirmed
    ) {
      return;
    }

    onDelete();
  }

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-[18px] border transition-all duration-150",

        active
          ? isDark
            ? "border-white/[0.18] bg-[#141414]"
            : "border-black/[0.20] bg-white"
          : isDark
            ? "border-white/[0.075] bg-[#0b0b0b] hover:border-white/[0.14] hover:bg-[#101010]"
            : "border-black/[0.09] bg-white hover:border-black/[0.16]",
      )}
    >
      <button
        type="button"
        onClick={
          onOpen
        }
        className="block w-full px-5 pb-5 pt-5 text-left"
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] border",

              isDark
                ? "border-white/[0.08] bg-[#151515]"
                : "border-black/[0.08] bg-zinc-100",
            )}
          >
            <Folder
              size={
                19
              }
              strokeWidth={
                1.8
              }
              className="text-zinc-400"
            />
          </div>

          <div className="min-w-0 flex-1 pr-6">
            <p className="truncate text-[14px] font-medium">
              {
                project.name
              }
            </p>

            <p className="mt-1 line-clamp-3 min-h-[51px] text-[11px] leading-[17px] text-zinc-600">
              {
                project.description
              }
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-zinc-500">
          <span className="flex items-center gap-1.5">
            <MessageSquare
              size={
                13
              }
            />

            {
              project
                .conversations
                .length
            }{" "}
            {project
              .conversations
              .length === 1
              ? "chat"
              : "chats"}
          </span>

          <span className="flex items-center gap-1.5">
            <FolderPlus
              size={
                13
              }
            />

            {
              project.files
                .length
            }{" "}
            {project.files
              .length === 1
              ? "source"
              : "sources"}
          </span>
        </div>

        <div className="mt-4 flex items-center gap-1.5 text-[10px] text-zinc-600">
          <Clock3
            size={
              12
            }
          />

          {formatRelativeTime(
            project.updatedAt,
          )}
        </div>
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          asChild
        >
          <button
            type="button"
            aria-label="Project options"
            title="Project options"
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-[9px] text-zinc-500 opacity-0 transition-opacity hover:bg-white/[0.07] hover:text-white focus:opacity-100 group-hover:opacity-100"
          >
            <MoreHorizontal
              size={
                17
              }
            />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            sideOffset={
              6
            }
            align="end"
            collisionPadding={
              12
            }
            className={cn(
              "z-[1200] w-[175px] rounded-[13px] border p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.65)]",

              isDark
                ? "border-white/[0.08] bg-[#202020]"
                : "border-black/[0.10] bg-white",
            )}
          >
            <DropdownAction
              icon={
                Pencil
              }
              label="Rename"
              onSelect={
                renameProject
              }
            />

            <div className="my-1 border-t border-white/[0.07]" />

            <DropdownAction
              icon={
                Trash2
              }
              label="Delete"
              destructive
              onSelect={
                deleteProject
              }
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </article>
  );
}

function ProjectsEmptyState({
  search,
  onClearSearch,
  onCreate,
}: {
  search: string;
  onClearSearch: () => void;
  onCreate: () => void;
}) {
  const hasSearch =
    search.trim().length >
    0;

  return (
    <div className="flex min-h-[430px] flex-col items-center justify-center text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-[16px] border border-white/[0.08] bg-[#101010]">
        {hasSearch ? (
          <Search
            size={
              21
            }
            className="text-zinc-500"
          />
        ) : (
          <Folder
            size={
              22
            }
            className="text-zinc-500"
          />
        )}
      </div>

      <h2 className="mt-5 text-[15px] font-medium">
        {hasSearch
          ? "No projects found"
          : "Create your first project"}
      </h2>

      <p className="mt-2 max-w-[390px] text-[12px] leading-5 text-zinc-500">
        {hasSearch
          ? "Try another search or clear the current search."
          : "Projects keep related chats, files and context organized together."}
      </p>

      <button
        type="button"
        onClick={
          hasSearch
            ? onClearSearch
            : onCreate
        }
        className="mt-5 flex h-10 items-center gap-2 rounded-[10px] bg-white px-4 text-[12px] font-medium text-black hover:bg-zinc-200"
      >
        {hasSearch ? (
          <>
            <X
              size={
                14
              }
            />

            Clear search
          </>
        ) : (
          <>
            <Plus
              size={
                14
              }
            />

            New project
          </>
        )}
      </button>
    </div>
  );
}

function DropdownAction({
  icon: Icon,
  label,
  destructive = false,
  onSelect,
}: {
  icon: ComponentType<{
    size?: number;
  }>;

  label: string;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={
        onSelect
      }
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2.5 text-[12px] outline-none",

        destructive
          ? "text-red-400 hover:bg-red-500/[0.08] focus:bg-red-500/[0.08]"
          : "text-zinc-300 hover:bg-white/[0.07] focus:bg-white/[0.07]",
      )}
    >
      <Icon
        size={
          15
        }
      />

      {
        label
      }
    </DropdownMenu.Item>
  );
}

function formatRelativeTime(
  timestamp:
    number,
) {
  const difference =
    Date.now() -
    timestamp;

  const minute =
    60 * 1000;

  const hour =
    60 * minute;

  const day =
    24 * hour;

  if (
    difference <
    minute
  ) {
    return "Updated just now";
  }

  if (
    difference <
    hour
  ) {
    return `Updated ${Math.max(
      1,
      Math.floor(
        difference /
          minute,
      ),
    )}m ago`;
  }

  if (
    difference <
    day
  ) {
    return `Updated ${Math.max(
      1,
      Math.floor(
        difference /
          hour,
      ),
    )}h ago`;
  }

  const days =
    Math.max(
      1,
      Math.floor(
        difference /
          day,
      ),
    );

  if (
    days ===
    1
  ) {
    return "Updated yesterday";
  }

  if (
    days <
    7
  ) {
    return `Updated ${days}d ago`;
  }

  return new Intl.DateTimeFormat(
    undefined,
    {
      month:
        "short",

      day:
        "numeric",
    },
  ).format(
    new Date(
      timestamp,
    ),
  );
}