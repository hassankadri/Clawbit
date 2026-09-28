"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion } from "framer-motion";

import {
  BookOpen,
  CircleHelp,
  Folder,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  PlugZap,
  Search,
  Settings2,
  SlidersHorizontal,
  SquarePen,
  Trash2,
  UserRound,
} from "lucide-react";

import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import ClawbitMark from "@/components/brand/ClawbitMark";
import UserAvatar from "@/components/common/UserAvatar";

import type { RouteView } from "@/lib/navigation";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

interface SidebarConversation {
  id: string;
  title: string;
  preview: string;
  pinned: boolean;
}

interface SidebarProps {
  theme: Theme;
  activeView: RouteView;
  collapsed: boolean;

  pinnedChats: SidebarConversation[];
  recentChats: SidebarConversation[];

  projects: Array<{
    id: string;
    name: string;
  }>;

  activeProjectId: string | null;
  activeConversationId: string | null;

  onOpenProject: (id: string) => void;

  onNewChat: () => void;
  onNavigate: (view: RouteView) => void;
  onToggleCollapsed: () => void;
  onOpenCommandPalette: () => void;

  onOpenConversation: (id: string) => void;
  onTogglePinConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;

  onRenameConversation: (
    id: string,
    title: string,
  ) => void;
}

/* ====================================================== */
/* NAVIGATION                                             */
/* ====================================================== */

const navigationItems = [
  {
    id: "projects",
    label: "Projects",
    icon: Folder,
  },
  {
    id: "plugins",
    label: "Tools",
    icon: PlugZap,
  },
  {
    id: "library",
    label: "Library",
    icon: BookOpen,
  },
] as const;

/* ====================================================== */
/* SIDEBAR WIDTH                                          */
/* ====================================================== */

const SIDEBAR_WIDTH_KEY =
  "clawbit.sidebar.width.v2";

const DEFAULT_SIDEBAR_WIDTH = 250;
const MIN_SIDEBAR_WIDTH = 210;
const MAX_SIDEBAR_WIDTH = 390;
const COLLAPSED_SIDEBAR_WIDTH = 56;

function clampSidebarWidth(
  width: number,
) {
  return Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(
      MIN_SIDEBAR_WIDTH,
      width,
    ),
  );
}

/* ====================================================== */
/* MAIN SIDEBAR                                           */
/* ====================================================== */

export default function Sidebar({
  theme,
  activeView,
  collapsed,

  pinnedChats,
  recentChats,

  projects,

  activeProjectId,
  activeConversationId,

  onOpenProject,

  onNewChat,
  onNavigate,
  onToggleCollapsed,
  onOpenCommandPalette,

  onOpenConversation,
  onTogglePinConversation,
  onDeleteConversation,
  onRenameConversation,
}: SidebarProps) {
  const asideRef =
    useRef<HTMLElement | null>(
      null,
    );

  const resizingRef =
    useRef(false);

  const sidebarWidthRef =
    useRef(
      DEFAULT_SIDEBAR_WIDTH,
    );

  const [
    sidebarWidth,
    setSidebarWidth,
  ] = useState(
    DEFAULT_SIDEBAR_WIDTH,
  );

  const [
    resizing,
    setResizing,
  ] = useState(false);

  const hasSidebarContent =
    projects.length > 0 ||
    pinnedChats.length > 0 ||
    recentChats.length > 0;

  /* ==================================================== */
  /* RESTORE WIDTH                                        */
  /* ==================================================== */

  useEffect(() => {
  let frameId: number | null = null;

  try {
    const saved =
      window.localStorage.getItem(
        SIDEBAR_WIDTH_KEY,
      );

    if (!saved) {
      return;
    }

    const parsed =
      Number(saved);

    if (
      !Number.isFinite(
        parsed,
      )
    ) {
      return;
    }

    const next =
      clampSidebarWidth(
        parsed,
      );

    sidebarWidthRef.current =
      next;

    /*
     * Restore the persisted width after the effect itself,
     * avoiding a synchronous state update inside useEffect.
     */
    frameId =
      window.requestAnimationFrame(
        () => {
          setSidebarWidth(
            next,
          );
        },
      );
  } catch {
    // localStorage unavailable.
  }

  return () => {
    if (
      frameId !== null
    ) {
      window.cancelAnimationFrame(
        frameId,
      );
    }
  };
}, []);

  /* ==================================================== */
  /* RESIZE LISTENERS                                     */
  /* ==================================================== */

  useEffect(() => {
    function handlePointerMove(
      event: PointerEvent,
    ) {
      if (
        !resizingRef.current
      ) {
        return;
      }

      const left =
        asideRef.current
          ?.getBoundingClientRect()
          .left ?? 0;

      const requestedWidth =
        event.clientX -
        left;

      const next =
        clampSidebarWidth(
          requestedWidth,
        );

      sidebarWidthRef.current =
        next;

      setSidebarWidth(
        next,
      );
    }

    function stopResizing() {
      if (
        !resizingRef.current
      ) {
        return;
      }

      resizingRef.current =
        false;

      setResizing(false);

      document.body.style.cursor =
        "";

      document.body.style.userSelect =
        "";

      try {
        window.localStorage.setItem(
          SIDEBAR_WIDTH_KEY,

          String(
            sidebarWidthRef.current,
          ),
        );
      } catch {
        // localStorage unavailable.
      }
    }

    window.addEventListener(
      "pointermove",
      handlePointerMove,
    );

    window.addEventListener(
      "pointerup",
      stopResizing,
    );

    window.addEventListener(
      "pointercancel",
      stopResizing,
    );

    return () => {
      window.removeEventListener(
        "pointermove",
        handlePointerMove,
      );

      window.removeEventListener(
        "pointerup",
        stopResizing,
      );

      window.removeEventListener(
        "pointercancel",
        stopResizing,
      );

      document.body.style.cursor =
        "";

      document.body.style.userSelect =
        "";
    };
  }, []);

  function startResizing(
    event:
      ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (collapsed) {
      return;
    }

    event.preventDefault();

    resizingRef.current =
      true;

    setResizing(true);

    document.body.style.cursor =
      "col-resize";

    document.body.style.userSelect =
      "none";
  }

  function resetSidebarWidth() {
    sidebarWidthRef.current =
      DEFAULT_SIDEBAR_WIDTH;

    setSidebarWidth(
      DEFAULT_SIDEBAR_WIDTH,
    );

    try {
      window.localStorage.setItem(
        SIDEBAR_WIDTH_KEY,

        String(
          DEFAULT_SIDEBAR_WIDTH,
        ),
      );
    } catch {
      // localStorage unavailable.
    }
  }

  /* ==================================================== */
  /* UI                                                   */
  /* ==================================================== */

  return (
    <motion.aside
      ref={asideRef}
      initial={false}
      animate={{
        width: collapsed
          ? COLLAPSED_SIDEBAR_WIDTH
          : sidebarWidth,
      }}
      transition={
        resizing
          ? {
              duration: 0,
            }
          : {
              type: "spring",
              stiffness: 300,
              damping: 32,
            }
      }
      className={cn(
        "relative flex h-screen shrink-0 overflow-x-hidden border-r",

        theme === "dark"
          ? "border-white/[0.055] bg-[#090909] text-white"
          : "border-black/[0.08] bg-[#f7f7f7] text-[#171717]",
      )}
    >
      {/* RESIZE HANDLE */}

      {!collapsed ? (
        <button
          type="button"
          aria-label="Resize sidebar"
          title="Drag to resize • Double-click to reset"
          onPointerDown={
            startResizing
          }
          onDoubleClick={
            resetSidebarWidth
          }
          className="group absolute -right-[4px] top-0 z-[450] h-full w-[8px] cursor-col-resize"
        >
          <span
            className={cn(
              "absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2 transition-all duration-150",

              resizing
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100",

              theme === "dark"
                ? "bg-white/20"
                : "bg-black/20",
            )}
          />
        </button>
      ) : null}

      <div
        className={cn(
          "flex h-full w-full min-w-0 flex-col",

          collapsed
            ? "px-2 pb-2 pt-3"
            : "px-3 pb-3 pt-4",
        )}
      >
        {/* BRAND */}

        <div className="flex h-11 shrink-0 items-center">
          {!collapsed ? (
            <>
              <div className="flex min-w-0 flex-1 items-center px-2">
                <ClawbitMark
                  variant="horizontal"
                  iconClassName="h-[23px] w-[23px]"
                  wordmarkClassName={cn(
                    "text-[17px] font-semibold tracking-[-0.035em]",

                    theme === "dark"
                      ? "text-white"
                      : "text-[#111111]",
                  )}
                />
              </div>

              <SidebarIconButton
                label="Close sidebar"
                icon={
                  PanelLeftClose
                }
                theme={theme}
                onClick={
                  onToggleCollapsed
                }
              />
            </>
          ) : (
            <CollapsedBrandButton
              theme={theme}
              onClick={
                onToggleCollapsed
              }
            />
          )}
        </div>

        {/* TOP ACTIONS */}

        <div
          className={cn(
            "shrink-0 space-y-1",

            collapsed
              ? "mt-4"
              : "mt-5",
          )}
        >
          <SidebarAction
            icon={SquarePen}
            label="New chat"
            collapsed={
              collapsed
            }
            theme={theme}
            active={false}
            onClick={
              onNewChat
            }
          />

          <SidebarAction
            icon={Search}
            label="Search"
            collapsed={
              collapsed
            }
            theme={theme}
            active={false}
            shortcut="Ctrl K"
            onClick={
              onOpenCommandPalette
            }
          />
        </div>

        {/* NAVIGATION */}

        <nav
          aria-label="Primary navigation"
          className="mt-5 shrink-0 space-y-1"
        >
          {navigationItems.map(
            (
              item,
            ) => (
              <SidebarAction
                key={
                  item.id
                }
                icon={
                  item.icon
                }
                label={
                  item.label
                }
                collapsed={
                  collapsed
                }
                theme={
                  theme
                }
                active={
                  activeView ===
                  item.id
                }
                onClick={() =>
                  onNavigate(
                    item.id,
                  )
                }
              />
            ),
          )}
        </nav>

        {/* HISTORY */}

        {!collapsed &&
        hasSidebarContent ? (
          <div className="mt-6 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-0.5 pb-4">
            {projects.length >
            0 ? (
              <SidebarSection
                title="Projects"
                theme={theme}
              >
                <div className="space-y-[2px]">
                  {projects.map(
                    (
                      project,
                    ) => {
                      const active =
                        activeView ===
                          "chats" &&
                        activeProjectId ===
                          project.id;

                      return (
                        <button
                          key={
                            project.id
                          }
                          type="button"
                          title={
                            project.name
                          }
                          aria-current={
                            active
                              ? "true"
                              : undefined
                          }
                          onClick={() =>
                            onOpenProject(
                              project.id,
                            )
                          }
                          className={cn(
                            "flex h-[40px] w-full min-w-0 items-center gap-3 rounded-[9px] px-2.5 text-left text-[13px] transition-colors",

                            active
                              ? theme ===
                                "dark"
                                ? "bg-white/[0.09] text-white"
                                : "bg-black/[0.075] text-[#111111]"
                              : theme ===
                                "dark"
                                ? "text-zinc-300 hover:bg-white/[0.055] hover:text-white"
                                : "text-zinc-700 hover:bg-black/[0.045] hover:text-black",
                          )}
                        >
                          <Folder
                            size={
                              17
                            }
                            strokeWidth={
                              1.8
                            }
                            className="shrink-0"
                          />

                          <span className="min-w-0 flex-1 truncate font-normal">
                            {
                              project.name
                            }
                          </span>
                        </button>
                      );
                    },
                  )}
                </div>
              </SidebarSection>
            ) : null}

            {pinnedChats.length >
            0 ? (
              <ConversationSection
                title="Pinned"
                items={
                  pinnedChats
                }
                theme={
                  theme
                }
                activeConversationId={
                  activeConversationId
                }
                onOpenConversation={
                  onOpenConversation
                }
                onTogglePinConversation={
                  onTogglePinConversation
                }
                onDeleteConversation={
                  onDeleteConversation
                }
                onRenameConversation={
                  onRenameConversation
                }
                className={
                  projects.length >
                  0
                    ? "mt-6"
                    : undefined
                }
              />
            ) : null}

            {recentChats.length >
            0 ? (
              <ConversationSection
                title="Recent"
                items={
                  recentChats
                }
                theme={
                  theme
                }
                activeConversationId={
                  activeConversationId
                }
                onOpenConversation={
                  onOpenConversation
                }
                onTogglePinConversation={
                  onTogglePinConversation
                }
                onDeleteConversation={
                  onDeleteConversation
                }
                onRenameConversation={
                  onRenameConversation
                }
                className={
                  projects.length >
                    0 ||
                  pinnedChats.length >
                    0
                    ? "mt-6"
                    : undefined
                }
              />
            ) : null}
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {/* ACCOUNT */}

        <div
          className={cn(
            "shrink-0 border-t pt-2",

            theme === "dark"
              ? "border-white/[0.06]"
              : "border-black/[0.08]",
          )}
        >
          <AccountMenu
            theme={theme}
            collapsed={
              collapsed
            }
            activeView={
              activeView
            }
            onNavigate={
              onNavigate
            }
          />
        </div>
      </div>
    </motion.aside>
  );
}

/* ====================================================== */
/* SECTION LABEL                                          */
/* ====================================================== */

function SidebarSection({
  title,
  children,
  theme,
}: {
  title: string;
  children: ReactNode;
  theme: Theme;
}) {
  return (
    <section aria-label={title}>
      <p
        className={cn(
          "mb-1.5 px-2.5 text-[11px] font-normal",

          theme === "dark"
            ? "text-zinc-600"
            : "text-zinc-500",
        )}
      >
        {title}
      </p>

      {children}
    </section>
  );
}

/* ====================================================== */
/* SIDEBAR ACTION                                         */
/* ====================================================== */

function SidebarAction({
  icon: Icon,
  label,
  collapsed,
  theme,
  active,
  shortcut,
  onClick,
}: {
  icon: ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;

  label: string;
  collapsed: boolean;
  theme: Theme;
  active: boolean;

  shortcut?: string;

  onClick: () => void;
}) {
  const [
    hovered,
    setHovered,
  ] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={
          label
        }
        aria-current={
          active
            ? "page"
            : undefined
        }
        onClick={
          onClick
        }
        onMouseEnter={() =>
          setHovered(true)
        }
        onMouseLeave={() =>
          setHovered(false)
        }
        onFocus={() =>
          setHovered(true)
        }
        onBlur={() =>
          setHovered(false)
        }
        className={cn(
          "flex h-[42px] items-center rounded-[9px] text-[13px] transition-colors",

          collapsed
            ? "mx-auto w-10 justify-center px-0"
            : "w-full gap-3 px-2.5",

          active
            ? theme === "dark"
              ? "bg-white/[0.09] text-white"
              : "bg-black/[0.075] text-black"
            : theme === "dark"
              ? "text-zinc-300 hover:bg-white/[0.055] hover:text-white"
              : "text-zinc-700 hover:bg-black/[0.045] hover:text-black",
        )}
      >
        <Icon
          size={18}
          strokeWidth={
            1.85
          }
          className="shrink-0"
        />

        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1 truncate text-left font-normal">
              {label}
            </span>

            {shortcut ? (
              <span
                className={cn(
                  "rounded-[6px] border px-1.5 py-0.5 text-[9px]",

                  theme === "dark"
                    ? "border-white/[0.08] text-zinc-600"
                    : "border-black/[0.10] text-zinc-500",
                )}
              >
                {
                  shortcut
                }
              </span>
            ) : null}
          </>
        ) : null}
      </button>

      <AnimatePresence>
        {collapsed &&
        hovered ? (
          <SidebarTooltip
            theme={theme}
          >
            {label}
          </SidebarTooltip>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ====================================================== */
/* COLLAPSED BUTTON                                       */
/* ====================================================== */

function CollapsedBrandButton({
  theme,
  onClick,
}: {
  theme: Theme;
  onClick: () => void;
}) {
  const [
    hovered,
    setHovered,
  ] = useState(false);

  return (
    <div className="relative flex w-full justify-center">
      <button
        type="button"
        aria-label="Open sidebar"
        onClick={
          onClick
        }
        onMouseEnter={() =>
          setHovered(true)
        }
        onMouseLeave={() =>
          setHovered(false)
        }
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-[9px] transition-colors",

          theme === "dark"
            ? "text-zinc-500 hover:bg-white/[0.055] hover:text-white"
            : "text-zinc-500 hover:bg-black/[0.045] hover:text-black",
        )}
      >
        <PanelLeftClose
          size={18}
          className="rotate-180"
        />
      </button>

      <AnimatePresence>
        {hovered ? (
          <SidebarTooltip
            theme={theme}
          >
            Open sidebar
          </SidebarTooltip>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ====================================================== */
/* ICON BUTTON                                            */
/* ====================================================== */

function SidebarIconButton({
  label,
  icon: Icon,
  theme,
  onClick,
}: {
  label: string;

  icon: ComponentType<{
    size?: number;
  }>;

  theme: Theme;

  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={
        label
      }
      title={
        label
      }
      onClick={
        onClick
      }
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] transition-colors",

        theme === "dark"
          ? "text-zinc-500 hover:bg-white/[0.055] hover:text-white"
          : "text-zinc-500 hover:bg-black/[0.045] hover:text-black",
      )}
    >
      <Icon
        size={
          17
        }
      />
    </button>
  );
}

/* ====================================================== */
/* TOOLTIP                                                */
/* ====================================================== */

function SidebarTooltip({
  theme,
  children,
}: {
  theme: Theme;
  children: ReactNode;
}) {
  return (
    <motion.div
      initial={{
        opacity: 0,
        x: -5,
      }}
      animate={{
        opacity: 1,
        x: 0,
      }}
      exit={{
        opacity: 0,
        x: -5,
      }}
      transition={{
        duration:
          0.12,
      }}
      className={cn(
        "pointer-events-none absolute left-[48px] top-1/2 z-[700] -translate-y-1/2 whitespace-nowrap rounded-[8px] border px-2.5 py-1.5 text-[12px] shadow-lg",

        theme === "dark"
          ? "border-white/[0.08] bg-[#202020] text-white"
          : "border-black/[0.10] bg-white text-[#181818]",
      )}
    >
      {children}
    </motion.div>
  );
}

/* ====================================================== */
/* CONVERSATIONS                                          */
/* ====================================================== */

function ConversationSection({
  title,
  items,
  theme,
  activeConversationId,
  onOpenConversation,
  onTogglePinConversation,
  onDeleteConversation,
  onRenameConversation,
  className,
}: {
  title: string;

  items:
    SidebarConversation[];

  theme:
    Theme;

  activeConversationId:
    | string
    | null;

  onOpenConversation: (
    id: string,
  ) => void;

  onTogglePinConversation: (
    id: string,
  ) => void;

  onDeleteConversation: (
    id: string,
  ) => void;

  onRenameConversation: (
    id: string,
    title: string,
  ) => void;

  className?: string;
}) {
  const [
    editingId,
    setEditingId,
  ] =
    useState<
      string | null
    >(null);

  const [
    draftTitle,
    setDraftTitle,
  ] =
    useState("");

  function startRename(
    item:
      SidebarConversation,
  ) {
    setEditingId(
      item.id,
    );

    setDraftTitle(
      item.title,
    );
  }

  function finishRename(
    id: string,
  ) {
    const trimmed =
      draftTitle.trim();

    if (trimmed) {
      onRenameConversation(
        id,
        trimmed,
      );
    }

    setEditingId(
      null,
    );

    setDraftTitle(
      "",
    );
  }

  return (
    <section
      aria-label={
        title
      }
      className={
        className
      }
    >
      <p
        className={cn(
          "mb-1.5 px-2.5 text-[11px] font-normal",

          theme === "dark"
            ? "text-zinc-600"
            : "text-zinc-500",
        )}
      >
        {title}
      </p>

      <div className="space-y-[2px]">
        {items.map(
          (
            item,
          ) => {
            const active =
              activeConversationId ===
              item.id;

            const editing =
              editingId ===
              item.id;

            return (
              <div
                key={
                  item.id
                }
                className={cn(
                  "group flex h-[40px] items-center rounded-[9px] px-2 transition-colors",

                  active
                    ? theme ===
                      "dark"
                      ? "bg-white/[0.09]"
                      : "bg-black/[0.075]"
                    : theme ===
                      "dark"
                      ? "hover:bg-white/[0.045]"
                      : "hover:bg-black/[0.035]",
                )}
              >
                {editing ? (
                  <input
                    autoFocus
                    value={
                      draftTitle
                    }
                    onChange={(
                      event,
                    ) =>
                      setDraftTitle(
                        event
                          .target
                          .value,
                      )
                    }
                    onBlur={() =>
                      finishRename(
                        item.id,
                      )
                    }
                    onKeyDown={(
                      event,
                    ) => {
                      if (
                        event.key ===
                        "Enter"
                      ) {
                        finishRename(
                          item.id,
                        );
                      }

                      if (
                        event.key ===
                        "Escape"
                      ) {
                        setEditingId(
                          null,
                        );

                        setDraftTitle(
                          "",
                        );
                      }
                    }}
                    className={cn(
                      "min-w-0 flex-1 rounded-[7px] border px-2 py-1 text-[13px] outline-none shadow-none",

                      theme === "dark"
                        ? "border-white/[0.11] bg-[#151515] text-white focus:border-white/[0.18]"
                        : "border-black/[0.12] bg-white text-[#171717] focus:border-black/[0.20]",
                    )}
                  />
                ) : (
                  <button
                    type="button"
                    title={
                      item.title
                    }
                    onClick={() =>
                      onOpenConversation(
                        item.id,
                      )
                    }
                    className={cn(
                      "min-w-0 flex-1 truncate bg-transparent text-left text-[13px] font-normal",

                      active
                        ? theme ===
                          "dark"
                          ? "text-white"
                          : "text-black"
                        : theme ===
                          "dark"
                          ? "text-zinc-300"
                          : "text-zinc-700",
                    )}
                  >
                    {
                      item.title
                    }
                  </button>
                )}

                {!editing ? (
                  <ConversationMenu
                    theme={
                      theme
                    }
                    item={
                      item
                    }
                    onRename={() =>
                      startRename(
                        item,
                      )
                    }
                    onTogglePin={() =>
                      onTogglePinConversation(
                        item.id,
                      )
                    }
                    onDelete={() =>
                      onDeleteConversation(
                        item.id,
                      )
                    }
                  />
                ) : null}
              </div>
            );
          },
        )}
      </div>
    </section>
  );
}

/* ====================================================== */
/* CONVERSATION MENU                                      */
/* ====================================================== */

function ConversationMenu({
  theme,
  item,
  onRename,
  onTogglePin,
  onDelete,
}: {
  theme: Theme;

  item:
    SidebarConversation;

  onRename:
    () => void;

  onTogglePin:
    () => void;

  onDelete:
    () => void;
}) {
  const [
    open,
    setOpen,
  ] = useState(false);

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={
        setOpen
      }
    >
      <DropdownMenu.Trigger
        asChild
      >
        <button
          type="button"
          aria-label="Conversation options"
          title="Conversation options"
          className={cn(
            "ml-1 h-7 w-7 shrink-0 items-center justify-center rounded-[7px] transition-colors",

            open
              ? "flex"
              : "hidden group-hover:flex",

            theme === "dark"
              ? "text-zinc-500 hover:bg-white/[0.07] hover:text-white"
              : "text-zinc-500 hover:bg-black/[0.055] hover:text-black",
          )}
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
          side="right"
          align="center"
          sideOffset={
            8
          }
          collisionPadding={
            10
          }
          className={cn(
            "z-[600] w-[190px] rounded-[14px] border p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.18)]",

            theme === "dark"
              ? "border-white/[0.09] bg-[#181818] text-white"
              : "border-black/[0.10] bg-white text-[#171717]",
          )}
        >
          <ConversationMenuItem
            theme={
              theme
            }
            icon={
              Pin
            }
            label={
              item.pinned
                ? "Unpin"
                : "Pin"
            }
            onSelect={
              onTogglePin
            }
          />

          <ConversationMenuItem
            theme={
              theme
            }
            icon={
              Pencil
            }
            label="Rename"
            onSelect={
              onRename
            }
          />

          <div
            className={cn(
              "my-1 border-t",

              theme === "dark"
                ? "border-white/[0.07]"
                : "border-black/[0.08]",
            )}
          />

          <ConversationMenuItem
            theme={
              theme
            }
            icon={
              Trash2
            }
            label="Delete"
            destructive
            onSelect={
              onDelete
            }
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ConversationMenuItem({
  theme,
  icon: Icon,
  label,
  destructive = false,
  onSelect,
}: {
  theme: Theme;

  icon:
    ComponentType<{
      size?: number;
    }>;

  label: string;

  destructive?:
    boolean;

  onSelect:
    () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={
        onSelect
      }
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2.5 text-[13px] outline-none transition-colors",

        destructive
          ? theme ===
            "dark"
            ? "text-red-400 hover:bg-red-500/[0.10] focus:bg-red-500/[0.10] data-[highlighted]:bg-red-500/[0.10]"
            : "text-red-600 hover:bg-red-50 focus:bg-red-50 data-[highlighted]:bg-red-50"
          : theme ===
            "dark"
            ? "text-zinc-200 hover:bg-white/[0.065] focus:bg-white/[0.065] data-[highlighted]:bg-white/[0.065]"
            : "text-zinc-800 hover:bg-black/[0.05] focus:bg-black/[0.05] data-[highlighted]:bg-black/[0.05]",
      )}
    >
      <Icon
        size={
          16
        }
      />

      {label}
    </DropdownMenu.Item>
  );
}

/* ====================================================== */
/* ACCOUNT MENU                                           */
/* ====================================================== */

function AccountMenu({
  collapsed,
  theme,
  activeView,
  onNavigate,
}: {
  collapsed: boolean;

  theme: Theme;

  activeView:
    RouteView;

  onNavigate: (
    view:
      RouteView,
  ) => void;
}) {
  const [
    open,
    setOpen,
  ] = useState(false);

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={
        setOpen
      }
    >
      <DropdownMenu.Trigger
        asChild
      >
        <button
          type="button"
          aria-label="Profile menu"
          className={cn(
            "mt-1 flex w-full items-center rounded-[10px] transition-colors",

            collapsed
              ? "mx-auto h-10 w-10 justify-center"
              : "min-h-[58px] gap-3 px-2",

            open
              ? theme ===
                "dark"
                ? "bg-white/[0.075]"
                : "bg-black/[0.055]"
              : theme ===
                "dark"
                ? "hover:bg-white/[0.05]"
                : "hover:bg-black/[0.04]",
          )}
        >
          <UserAvatar />

          {!collapsed ? (
            <>
              <div className="min-w-0 flex-1 text-left">
                <p
                  className={cn(
                    "truncate text-[13px] font-medium",

                    theme === "dark"
                      ? "text-zinc-100"
                      : "text-zinc-900",
                  )}
                >
                  Hassan Kadri
                </p>

                <p
                  className={cn(
                    "mt-0.5 text-[10px]",

                    theme === "dark"
                      ? "text-zinc-600"
                      : "text-zinc-500",
                  )}
                >
                  Personal workspace
                </p>
              </div>

              <MoreHorizontal
                size={
                  16
                }
                className={
                  theme === "dark"
                    ? "text-zinc-600"
                    : "text-zinc-500"
                }
              />
            </>
          ) : null}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="center"
          sideOffset={
            8
          }
          collisionPadding={
            12
          }
          className={cn(
            "z-[600] w-[270px] rounded-[17px] border p-2 shadow-[0_18px_55px_rgba(0,0,0,0.18)]",

            theme === "dark"
              ? "border-white/[0.09] bg-[#181818] text-white"
              : "border-black/[0.10] bg-white text-[#171717]",
          )}
        >
          <div className="flex items-center gap-3 px-2.5 py-2.5">
            <UserAvatar />

            <div className="min-w-0">
              <p
                className={cn(
                  "truncate text-[13px] font-medium",

                  theme === "dark"
                    ? "text-white"
                    : "text-[#171717]",
                )}
              >
                Hassan Kadri
              </p>

              <p
                className={cn(
                  "mt-0.5 text-[11px]",

                  theme === "dark"
                    ? "text-zinc-500"
                    : "text-zinc-500",
                )}
              >
                Personal workspace
              </p>
            </div>
          </div>

          <MenuDivider
            theme={
              theme
            }
          />

          <AccountMenuItem
            theme={
              theme
            }
            icon={
              SlidersHorizontal
            }
            label="Personalization"
            active={
              activeView ===
              "customize"
            }
            onSelect={() =>
              onNavigate(
                "customize",
              )
            }
          />

          <AccountMenuItem
            theme={
              theme
            }
            icon={
              UserRound
            }
            label="Profile"
            active={
              activeView ===
              "profile"
            }
            onSelect={() =>
              onNavigate(
                "profile",
              )
            }
          />

          <AccountMenuItem
            theme={
              theme
            }
            icon={
              Settings2
            }
            label="Settings"
            active={
              activeView ===
              "settings"
            }
            onSelect={() =>
              onNavigate(
                "settings",
              )
            }
          />

          <MenuDivider
            theme={
              theme
            }
          />

          <AccountMenuItem
            theme={
              theme
            }
            icon={
              CircleHelp
            }
            label="Help & Docs"
            active={
              activeView ===
              "help"
            }
            onSelect={() =>
              onNavigate(
                "help",
              )
            }
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AccountMenuItem({
  theme,
  icon: Icon,
  label,
  active,
  onSelect,
}: {
  theme: Theme;

  icon:
    ComponentType<{
      size?: number;
    }>;

  label:
    string;

  active:
    boolean;

  onSelect:
    () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={
        onSelect
      }
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2.5 text-[13px] outline-none transition-colors",

        active
          ? theme ===
            "dark"
            ? "bg-white/[0.085] text-white"
            : "bg-black/[0.065] text-black"
          : theme ===
            "dark"
            ? "text-zinc-200 hover:bg-white/[0.06] focus:bg-white/[0.06] data-[highlighted]:bg-white/[0.06]"
            : "text-zinc-800 hover:bg-black/[0.045] focus:bg-black/[0.045] data-[highlighted]:bg-black/[0.045]",
      )}
    >
      <Icon
        size={
          16
        }
      />

      {label}
    </DropdownMenu.Item>
  );
}

function MenuDivider({
  theme,
}: {
  theme: Theme;
}) {
  return (
    <div
      className={cn(
        "my-1.5 border-t",

        theme === "dark"
          ? "border-white/[0.07]"
          : "border-black/[0.08]",
      )}
    />
  );
}