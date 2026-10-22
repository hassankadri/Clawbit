"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useTheme } from "next-themes";

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
  type LucideIcon,
} from "lucide-react";

import {
  useMemo,
  useState,
  type ReactNode,
} from "react";

import SettingsWorkspace from "@/components/settings/SettingsWorkspace";

import type { RouteView } from "@/lib/navigation";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

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
  onMarkNotificationRead: (id: string) => void;
  onDismissNotification: (id: string) => void;
  onNavigate: (view: RouteView) => void;
  onShareChat: () => Promise<ShareResult>;
  onTogglePinChat: () => void;
  onMoveChatToProject: (projectId: string) => void;
  onViewFiles: () => void;
  onDeleteChat: () => void;
}

function TopbarIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="ui-icon-button"
    >
      {children}
    </button>
  );
}

function ChatAction({
  icon: Icon,
  label,
  onSelect,
  disabled,
  destructive = false,
}: {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-xs outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-35",
        destructive
          ? "text-red-500 hover:bg-red-500/[0.08] focus:bg-red-500/[0.08] data-[highlighted]:bg-red-500/[0.08]"
          : "text-[color:var(--foreground)] hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)] data-[highlighted]:bg-[color:var(--accent-hover)]",
      )}
    >
      <Icon size={15} />
      {label}
    </DropdownMenu.Item>
  );
}

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
  const { setTheme } = useTheme();

  const [notificationsOpen, setNotificationsOpen] =
    useState(false);

  const [menuOpen, setMenuOpen] = useState(false);

  const [shareState, setShareState] =
    useState<"idle" | "copied">("idle");

  const unreadCount = useMemo(
    () => notifications.filter((item) => !item.read).length,
    [notifications],
  );

  async function handleShare() {
    if (!hasActiveChat) return;

    if ((await onShareChat()) !== "copied") {
      return;
    }

    setShareState("copied");

    window.setTimeout(() => {
      setShareState("idle");
    }, 1500);
  }

  /*
   * Profile, Personalization and Help use the
   * same modal as Settings.
   *
   * Their existing routes remain unchanged.
   */

  const modalView =
    activeView === "profile" ||
    activeView === "customize" ||
    activeView === "help";

  const initialSection =
    activeView === "profile"
      ? ("profile" as const)
      : activeView === "customize"
        ? ("personalization" as const)
        : ("help" as const);

  return (
    <>
      <header className="relative z-20 flex h-[58px] shrink-0 items-center justify-end bg-transparent px-4 text-[color:var(--foreground)] lg:px-5">
        <div className="flex items-center gap-1">
          {/* THEME */}

          <TopbarIconButton
            label={
              theme === "dark"
                ? "Light mode"
                : "Dark mode"
            }
            onClick={() =>
              setTheme(
                theme === "dark" ? "light" : "dark",
              )
            }
          >
            {theme === "dark" ? (
              <Sun size={16} />
            ) : (
              <Moon size={16} />
            )}
          </TopbarIconButton>

          {/* NOTIFICATIONS */}

          {notificationsEnabled && (
            <DropdownMenu.Root
              open={notificationsOpen}
              onOpenChange={setNotificationsOpen}
            >
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  title="Notifications"
                  aria-label="Notifications"
                  className={cn(
                    "ui-icon-button relative",
                    notificationsOpen &&
                      "bg-[color:var(--accent-hover)] text-[color:var(--foreground)]",
                  )}
                >
                  <Bell size={16} />

                  {unreadCount > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute right-[6px] top-[6px] h-[5px] w-[5px] rounded-full bg-blue-500"
                    />
                  )}
                </button>
              </DropdownMenu.Trigger>

              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  sideOffset={10}
                  align="end"
                  collisionPadding={12}
                  className="ui-menu-surface z-[1200] w-[350px] max-w-[90vw] p-2 text-[color:var(--foreground)] outline-none"
                >
                  <div className="flex items-center justify-between gap-3 px-2.5 pb-2 pt-1.5">
                    <div>
                      <p className="text-[13px] font-semibold">
                        Notifications
                      </p>

                      <p className="mt-1 text-[11px] text-[color:var(--muted-foreground)]">
                        Recent workspace activity
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={unreadCount === 0}
                      onClick={onMarkAllRead}
                      className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] disabled:opacity-35"
                    >
                      <CheckCheck size={13} />
                      Read all
                    </button>
                  </div>

                  <DropdownMenu.Separator className="my-1 h-px bg-[color:var(--border)]" />

                  <div className="max-h-[360px] space-y-1 overflow-y-auto pt-1">
                    {notifications.length ? (
                      notifications.map((item) => (
                        <div
                          key={item.id}
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            onMarkNotificationRead(item.id)
                          }
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" ||
                              event.key === " "
                            ) {
                              event.preventDefault();

                              onMarkNotificationRead(
                                item.id,
                              );
                            }
                          }}
                          className={cn(
                            "group relative cursor-pointer rounded-xl px-3 py-2.5 pr-9 outline-none hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)]",
                            !item.read &&
                              "bg-[color:var(--accent-hover)]",
                          )}
                        >
                          {!item.read && (
                            <span
                              aria-hidden="true"
                              className="absolute left-[6px] top-[17px] h-[5px] w-[5px] rounded-full bg-blue-500"
                            />
                          )}

                          <p
                            className={cn(
                              "pl-1 text-xs",
                              item.read
                                ? "font-normal"
                                : "font-medium",
                            )}
                          >
                            {item.title}
                          </p>

                          <p className="mt-1 pl-1 text-[11px] leading-5 text-[color:var(--muted-foreground)]">
                            {item.detail}
                          </p>

                          <button
                            type="button"
                            title="Dismiss"
                            aria-label={`Dismiss ${item.title}`}
                            onClick={(event) => {
                              event.stopPropagation();

                              onDismissNotification(
                                item.id,
                              );
                            }}
                            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-[color:var(--muted-foreground)] opacity-0 hover:bg-[color:var(--accent-hover)] group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="flex min-h-[100px] flex-col items-center justify-center gap-2 text-xs text-[color:var(--muted-foreground)]">
                        <Bell size={18} />
                        Nothing new
                      </div>
                    )}
                  </div>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}

          {/* SHARE AND CHAT OPTIONS */}

          {activeView === "chats" && (
            <>
              <button
                type="button"
                disabled={!hasActiveChat}
                onClick={() => {
                  void handleShare();
                }}
                aria-label="Share chat"
                title={
                  hasActiveChat
                    ? "Share chat"
                    : "Start a conversation to share"
                }
                className="ml-1 inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs hover:bg-[color:var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Share2 size={15} />

                {shareState === "copied"
                  ? "Copied"
                  : "Share"}
              </button>

              <DropdownMenu.Root
                open={menuOpen}
                onOpenChange={setMenuOpen}
              >
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    title="Chat options"
                    aria-label="Chat options"
                    className={cn(
                      "ui-icon-button",
                      menuOpen &&
                        "bg-[color:var(--accent-hover)] text-[color:var(--foreground)]",
                    )}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                </DropdownMenu.Trigger>

                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    sideOffset={10}
                    align="end"
                    collisionPadding={12}
                    className="ui-menu-surface z-[1200] w-[245px] p-1.5 outline-none"
                  >
                    <ChatAction
                      icon={
                        activeChatPinned ? PinOff : Pin
                      }
                      label={
                        activeChatPinned
                          ? "Unpin"
                          : "Pin"
                      }
                      disabled={
                        !hasActiveChat || chatInProject
                      }
                      onSelect={onTogglePinChat}
                    />

                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger
                        disabled={
                          !hasActiveChat ||
                          chatInProject ||
                          projects.length === 0
                        }
                        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-xs outline-none hover:bg-[color:var(--accent-hover)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-35"
                      >
                        <FolderInput size={15} />

                        <span className="flex-1 text-left">
                          Move to project
                        </span>

                        <ChevronRight
                          size={14}
                          className="text-[color:var(--muted-foreground)]"
                        />
                      </DropdownMenu.SubTrigger>

                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent
                          sideOffset={8}
                          alignOffset={-5}
                          collisionPadding={12}
                          className="ui-menu-surface z-[1210] min-w-[220px] p-1.5 outline-none"
                        >
                          <p className="px-2.5 pb-1.5 pt-1 text-[10px] text-[color:var(--muted-foreground)]">
                            Projects
                          </p>

                          {projects.map((project) => (
                            <DropdownMenu.Item
                              key={project.id}
                              onSelect={() =>
                                onMoveChatToProject(
                                  project.id,
                                )
                              }
                              className="cursor-pointer rounded-lg px-2.5 py-2.5 text-xs outline-none hover:bg-[color:var(--accent-hover)] data-[highlighted]:bg-[color:var(--accent-hover)]"
                            >
                              {project.name}
                            </DropdownMenu.Item>
                          ))}
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>

                    <ChatAction
                      icon={FileText}
                      label="View files in chat"
                      disabled={!hasActiveChat}
                      onSelect={onViewFiles}
                    />

                    <DropdownMenu.Separator className="my-1 h-px bg-[color:var(--border)]" />

                    <ChatAction
                      icon={Trash2}
                      label="Delete"
                      disabled={!hasActiveChat}
                      destructive
                      onSelect={onDeleteChat}
                    />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </>
          )}
        </div>
      </header>

      {/* MODAL ROUTES */}

      {modalView && (
        <SettingsWorkspace
          key={activeView}
          initialSection={initialSection}
          onExitSettings={() =>
            onNavigate("chats")
          }
        />
      )}
    </>
  );
}