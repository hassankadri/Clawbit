"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import {
  Bell,
  CheckCheck,
  ChevronRight,
  FileText,
  FolderInput,
  MoreHorizontal,
  Moon,
  Pin,
  PinOff,
  Share2,
  Sun,
  Trash2,
  X,
} from "lucide-react";

import { useTheme } from "next-themes";

import {
  useMemo,
  useState,
  type ComponentType,
} from "react";

import type { RouteView } from "@/lib/navigation";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

export interface NotificationItem {
  id: string;
  title: string;
  detail: string;
  read: boolean;
}

interface TopbarProject {
  id: string;
  name: string;
}

export type ShareResult =
  | "shared"
  | "copied"
  | "cancelled"
  | "empty";

interface TopbarProps {
  theme: Theme;

  activeView: RouteView;

  notifications: NotificationItem[];

  notificationsEnabled: boolean;

  hasActiveChat: boolean;

  activeChatPinned: boolean;

  chatInProject: boolean;

  projects: TopbarProject[];

  onMarkAllRead: () => void;

  onMarkNotificationRead: (
    id: string,
  ) => void;

  onDismissNotification: (
    id: string,
  ) => void;

  onNavigate: (
    view: RouteView,
  ) => void;

  onShareChat: () => Promise<ShareResult>;

  onTogglePinChat: () => void;

  onMoveChatToProject: (
    projectId: string,
  ) => void;

  onViewFiles: () => void;

  onDeleteChat: () => void;
}

/* ====================================================== */
/* TOPBAR                                                 */
/* ====================================================== */

export default function Topbar({
  theme,
  activeView,
  notifications,
  notificationsEnabled,
  hasActiveChat,
  activeChatPinned,
  chatInProject,
  projects,
  onMarkAllRead,
  onMarkNotificationRead,
  onDismissNotification,
  onNavigate,
  onShareChat,
  onTogglePinChat,
  onMoveChatToProject,
  onViewFiles,
  onDeleteChat,
}: TopbarProps) {
  const { setTheme } =
    useTheme();

  const [
    notificationsOpen,
    setNotificationsOpen,
  ] = useState(false);

  const [
    menuOpen,
    setMenuOpen,
  ] = useState(false);

  const [
    shareState,
    setShareState,
  ] = useState<
    "idle" | "copied"
  >("idle");

  const unreadCount =
    useMemo(
      () =>
        notifications.filter(
          (item) =>
            !item.read,
        ).length,
      [notifications],
    );

  /* ==================================================== */
  /* SHARE                                                */
  /* ==================================================== */

  async function handleShare() {
    if (
      !hasActiveChat
    ) {
      return;
    }

    const result =
      await onShareChat();

    if (
      result !==
      "copied"
    ) {
      return;
    }

    setShareState(
      "copied",
    );

    window.setTimeout(
      () => {
        setShareState(
          "idle",
        );
      },
      1500,
    );
  }

  /* ==================================================== */
  /* UI                                                   */
  /* ==================================================== */

  return (
    <header className="relative z-20 flex h-[58px] shrink-0 items-center justify-end border-b border-[color:var(--border)] bg-[color:var(--background)] px-4 text-[color:var(--foreground)] lg:px-5">
      <div className="flex items-center gap-1">
        {/* ============================================= */}
        {/* CLOSE NON-CHAT PAGE                          */}
        {/* ============================================= */}

        {activeView !==
          "chats" &&
        activeView !==
          "settings" ? (
          <TopbarIconButton
            title="Close"
            onClick={() =>
              onNavigate(
                "chats",
              )
            }
          >
            <X
              size={
                16
              }
            />
          </TopbarIconButton>
        ) : null}

        {/* ============================================= */}
        {/* THEME                                        */}
        {/* ============================================= */}

        <TopbarIconButton
          title={
            theme ===
            "dark"
              ? "Light mode"
              : "Dark mode"
          }
          onClick={() =>
            setTheme(
              theme ===
                "dark"
                ? "light"
                : "dark",
            )
          }
        >
          {theme ===
          "dark" ? (
            <Sun
              size={
                16
              }
            />
          ) : (
            <Moon
              size={
                16
              }
            />
          )}
        </TopbarIconButton>

        {/* ============================================= */}
        {/* NOTIFICATIONS                                */}
        {/* ============================================= */}

        {notificationsEnabled ? (
          <DropdownMenu.Root
            open={
              notificationsOpen
            }
            onOpenChange={
              setNotificationsOpen
            }
          >
            <DropdownMenu.Trigger
              asChild
            >
              <button
                type="button"
                title="Notifications"
                aria-label="Notifications"
                className={cn(
                  "ui-icon-button relative",

                  notificationsOpen
                    ? "bg-[color:var(--accent-hover)] text-[color:var(--foreground)]"
                    : "",
                )}
              >
                <Bell
                  size={
                    16
                  }
                />

                {unreadCount >
                0 ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-[6px] top-[6px] h-[5px] w-[5px] rounded-full bg-blue-500"
                  />
                ) : null}
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                sideOffset={
                  10
                }
                align="end"
                collisionPadding={
                  12
                }
                className="ui-menu-surface z-[1200] w-[350px] p-2 text-[color:var(--foreground)] outline-none"
              >
                {/* HEADER */}

                <div className="flex items-center justify-between gap-3 px-2.5 pb-2 pt-1.5">
                  <div>
                    <p className="text-[13px] font-semibold text-[color:var(--foreground)]">
                      Notifications
                    </p>

                    <p className="mt-1 text-[11px] text-[color:var(--muted-foreground)]">
                      Recent workspace
                      activity
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={
                      unreadCount ===
                      0
                    }
                    onClick={
                      onMarkAllRead
                    }
                    className="flex items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[11px] text-[color:var(--muted-foreground)] transition-colors hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <CheckCheck
                      size={
                        13
                      }
                    />

                    Read all
                  </button>
                </div>

                <DropdownMenu.Separator className="mx-1 my-1 h-px bg-[color:var(--border)]" />

                {/* LIST */}

                <div className="max-h-[360px] space-y-1 overflow-y-auto pt-1">
                  {notifications.length >
                  0 ? (
                    notifications.map(
                      (
                        item,
                      ) => (
                        <div
                          key={
                            item.id
                          }
                          role="button"
                          tabIndex={
                            0
                          }
                          onClick={() =>
                            onMarkNotificationRead(
                              item.id,
                            )
                          }
                          onKeyDown={(
                            event,
                          ) => {
                            if (
                              event.key ===
                                "Enter" ||
                              event.key ===
                                " "
                            ) {
                              event.preventDefault();

                              onMarkNotificationRead(
                                item.id,
                              );
                            }
                          }}
                          className={cn(
                            "group relative cursor-pointer rounded-[11px] px-3 py-2.5 pr-9 outline-none transition-colors hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)]",

                            !item.read
                              ? "bg-[color:var(--accent-hover)]"
                              : "",
                          )}
                        >
                          {!item.read ? (
                            <span
                              aria-hidden="true"
                              className="absolute left-[6px] top-[17px] h-[5px] w-[5px] rounded-full bg-blue-500"
                            />
                          ) : null}

                          <p
                            className={cn(
                              "pl-1 text-[12px] text-[color:var(--foreground)]",

                              item.read
                                ? "font-normal"
                                : "font-medium",
                            )}
                          >
                            {
                              item.title
                            }
                          </p>

                          <p className="mt-1 pl-1 text-[11px] leading-5 text-[color:var(--muted-foreground)]">
                            {
                              item.detail
                            }
                          </p>

                          <button
                            type="button"
                            title="Dismiss"
                            aria-label={`Dismiss ${item.title}`}
                            onClick={(
                              event,
                            ) => {
                              event.stopPropagation();

                              onDismissNotification(
                                item.id,
                              );
                            }}
                            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-[color:var(--muted-foreground)] opacity-0 transition-colors hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)] group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            <X
                              size={
                                12
                              }
                            />
                          </button>
                        </div>
                      ),
                    )
                  ) : (
                    <div className="flex min-h-[110px] flex-col items-center justify-center px-4 text-center">
                      <Bell
                        size={
                          18
                        }
                        className="text-[color:var(--muted-foreground)]"
                      />

                      <p className="mt-3 text-[12px] font-medium text-[color:var(--foreground)]">
                        Nothing new
                      </p>

                      <p className="mt-1 text-[10px] text-[color:var(--muted-foreground)]">
                        New workspace
                        activity will
                        appear here.
                      </p>
                    </div>
                  )}
                </div>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}

        {/* ============================================= */}
        {/* CHAT CONTROLS                                 */}
        {/* ============================================= */}

        {activeView ===
        "chats" ? (
          <>
            {/* SHARE */}

            <button
              type="button"
              disabled={
                !hasActiveChat
              }
              onClick={() =>
                void handleShare()
              }
              title={
                hasActiveChat
                  ? "Share chat"
                  : "Start a conversation to share"
              }
              className={cn(
                "ml-1 inline-flex h-9 items-center gap-2 rounded-[10px] px-3 text-[12px] transition-colors",

                "text-[color:var(--foreground)] hover:bg-[color:var(--accent-hover)]",

                "disabled:cursor-not-allowed disabled:opacity-35",
              )}
            >
              <Share2
                size={
                  15
                }
              />

              <span>
                {shareState ===
                "copied"
                  ? "Copied"
                  : "Share"}
              </span>
            </button>

            {/* ========================================= */}
            {/* CHAT OPTIONS                              */}
            {/* ========================================= */}

            <DropdownMenu.Root
              open={
                menuOpen
              }
              onOpenChange={
                setMenuOpen
              }
            >
              <DropdownMenu.Trigger
                asChild
              >
                <button
                  type="button"
                  title="Chat options"
                  aria-label="Chat options"
                  className={cn(
                    "ui-icon-button",

                    menuOpen
                      ? "bg-[color:var(--accent-hover)] text-[color:var(--foreground)]"
                      : "",
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
                  sideOffset={
                    10
                  }
                  align="end"
                  collisionPadding={
                    12
                  }
                  className="ui-menu-surface z-[1200] w-[245px] p-1.5 text-[color:var(--foreground)] outline-none"
                >
                  {/* PIN */}

                  <ChatMenuItem
                    icon={
                      activeChatPinned
                        ? PinOff
                        : Pin
                    }
                    label={
                      activeChatPinned
                        ? "Unpin"
                        : "Pin"
                    }
                    disabled={
                      !hasActiveChat ||
                      chatInProject
                    }
                    onSelect={
                      onTogglePinChat
                    }
                  />

                  {/* =================================== */}
                  {/* MOVE TO PROJECT                     */}
                  {/* =================================== */}

                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger
                      disabled={
                        !hasActiveChat ||
                        chatInProject ||
                        projects.length ===
                          0
                      }
                      className="flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2.5 text-[12px] text-[color:var(--foreground)] outline-none transition-colors hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-35"
                    >
                      <FolderInput
                        size={
                          15
                        }
                      />

                      <span className="flex-1">
                        Move to project
                      </span>

                      <ChevronRight
                        size={
                          14
                        }
                        className="text-[color:var(--muted-foreground)]"
                      />
                    </DropdownMenu.SubTrigger>

                    <DropdownMenu.Portal>
                      <DropdownMenu.SubContent
                        sideOffset={
                          8
                        }
                        alignOffset={
                          -5
                        }
                        collisionPadding={
                          12
                        }
                        className="ui-menu-surface z-[1210] min-w-[220px] p-1.5 text-[color:var(--foreground)] outline-none"
                      >
                        <p className="px-2.5 pb-1.5 pt-1 text-[9px] font-medium uppercase tracking-[0.12em] text-[color:var(--muted-foreground)]">
                          Projects
                        </p>

                        {projects.map(
                          (
                            project,
                          ) => (
                            <DropdownMenu.Item
                              key={
                                project.id
                              }
                              onSelect={() =>
                                onMoveChatToProject(
                                  project.id,
                                )
                              }
                              className="cursor-pointer rounded-[9px] px-2.5 py-2.5 text-[12px] text-[color:var(--foreground)] outline-none transition-colors hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)]"
                            >
                              <span className="block truncate">
                                {
                                  project.name
                                }
                              </span>
                            </DropdownMenu.Item>
                          ),
                        )}
                      </DropdownMenu.SubContent>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Sub>

                  {/* VIEW FILES */}

                  <ChatMenuItem
                    icon={
                      FileText
                    }
                    label="View files in chat"
                    disabled={
                      !hasActiveChat
                    }
                    onSelect={
                      onViewFiles
                    }
                  />

                  <DropdownMenu.Separator className="my-1 h-px bg-[color:var(--border)]" />

                  {/* DELETE */}

                  <ChatMenuItem
                    icon={
                      Trash2
                    }
                    label="Delete"
                    disabled={
                      !hasActiveChat
                    }
                    destructive
                    onSelect={
                      onDeleteChat
                    }
                  />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </>
        ) : null}
      </div>
    </header>
  );
}

/* ====================================================== */
/* TOPBAR ICON BUTTON                                     */
/* ====================================================== */

function TopbarIconButton({
  title,
  onClick,
  children,
}: {
  title: string;

  onClick: () => void;

  children:
    React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={
        title
      }
      aria-label={
        title
      }
      onClick={
        onClick
      }
      className="ui-icon-button"
    >
      {children}
    </button>
  );
}

/* ====================================================== */
/* CHAT MENU ITEM                                         */
/* ====================================================== */

function ChatMenuItem({
  icon: Icon,
  label,
  onSelect,
  disabled = false,
  destructive = false,
}: {
  icon:
    ComponentType<{
      size?: number;
    }>;

  label: string;

  onSelect: () => void;

  disabled?: boolean;

  destructive?: boolean;
}) {
  return (
    <DropdownMenu.Item
      disabled={
        disabled
      }
      onSelect={
        onSelect
      }
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2.5 text-[12px] outline-none transition-colors",

        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-35",

        destructive
          ? "text-red-600 hover:bg-red-50 focus:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/[0.08] dark:focus:bg-red-500/[0.08]"
          : "text-[color:var(--foreground)] hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)]",
      )}
    >
      <Icon
        size={
          15
        }
      />

      {label}
    </DropdownMenu.Item>
  );
}