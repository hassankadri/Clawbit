"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import {
  AnimatePresence,
  motion,
} from "framer-motion";

import {
  CircleHelp,
  FolderKanban,
  MessageSquare,
  MoreHorizontal,
  Palette,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  PlugZap,
  Search,
  Settings2,
  Share2,
  SlidersHorizontal,
  Trash2,
  UserRound,
} from "lucide-react";

import {
  useState,
  type ComponentType,
} from "react";

import ClawbitMark from "@/components/brand/ClawbitMark";
import UserAvatar from "@/components/common/UserAvatar";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type AppView =
  | "chats"
  | "projects"
  | "plugins"
  | "customize"
  | "settings"
  | "help";

interface SidebarConversation {
  id: string;
  title: string;
  preview: string;
  pinned: boolean;
}

interface SidebarProps {
  theme: Theme;
  activeView: AppView;
  collapsed: boolean;

  pinnedChats: SidebarConversation[];
  recentChats: SidebarConversation[];

  activeConversationId: string | null;

  onNewChat: () => void;
  onNavigate: (view: AppView) => void;
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

const navigationItems = [
  {
    id: "chats",
    label: "Chats",
    icon: MessageSquare,
  },
  {
    id: "projects",
    label: "Workspaces",
    icon: FolderKanban,
  },
  {
    id: "plugins",
    label: "Tools",
    icon: PlugZap,
  },
  {
    id: "customize",
    label: "Customize",
    icon: Palette,
  },
] as const;

export default function Sidebar({
  theme,
  activeView,
  collapsed,

  pinnedChats,
  recentChats,

  activeConversationId,

  onNewChat,
  onNavigate,
  onToggleCollapsed,
  onOpenCommandPalette,

  onOpenConversation,
  onTogglePinConversation,
  onDeleteConversation,
  onRenameConversation,
}: SidebarProps) {
  return (
    <motion.aside
      initial={false}
      animate={{
        width: collapsed ? 52 : 250,
      }}
      transition={{
        type: "spring",
        stiffness: 290,
        damping: 31,
      }}
      className={cn(
        "relative hidden h-screen shrink-0 border-r xl:flex",

        theme === "dark"
          ? collapsed
            ? "border-white/[0.055] bg-[#0b0b0b]"
            : "border-white/[0.055] bg-[#181818]"
          : collapsed
            ? "border-black/[0.08] bg-white"
            : "border-black/[0.08] bg-[#f3f3f3]",
      )}
    >
      <div
        className={cn(
          "flex h-full w-full min-w-0 flex-col",
          collapsed
            ? "px-1 pb-2 pt-3"
            : "px-3 pb-3 pt-4",
        )}
      >
        {/* BRAND */}

        <div className="flex h-11 items-center">
          {!collapsed ? (
            <>
              <div className="flex min-w-0 flex-1 items-center px-2">
                <ClawbitMark
                  variant="horizontal"
                  iconClassName={cn(
                    "h-[23px] w-[23px]",
                    theme === "dark"
                      ? "text-white"
                      : "text-black",
                  )}
                  wordmarkClassName={cn(
                    "text-[17px] font-semibold tracking-[-0.035em]",
                    theme === "dark"
                      ? "text-white"
                      : "text-black",
                  )}
                />
              </div>

              <SidebarIconButton
                label="Close sidebar"
                icon={PanelLeftClose}
                theme={theme}
                onClick={onToggleCollapsed}
              />
            </>
          ) : (
            <div className="flex w-full justify-center">
              <CollapsedBrandButton
                theme={theme}
                onClick={onToggleCollapsed}
              />
            </div>
          )}
        </div>

        {/* TOP ACTIONS */}

        <div className={collapsed ? "mt-4" : "mt-7"}>
          <SidebarAction
            icon={Plus}
            label="New chat"
            collapsed={collapsed}
            theme={theme}
            onClick={onNewChat}
          />

          <div className="mt-1">
            <SidebarAction
              icon={Search}
              label="Search"
              collapsed={collapsed}
              theme={theme}
              onClick={onOpenCommandPalette}
              shortcut="Ctrl K"
            />
          </div>
        </div>

        {/* NAV */}

        <nav className="mt-5 space-y-1">
          {navigationItems.map((item) => (
            <SidebarAction
              key={item.id}
              icon={item.icon}
              label={item.label}
              collapsed={collapsed}
              theme={theme}
              active={
                activeView === item.id
              }
              onClick={() =>
                onNavigate(item.id)
              }
            />
          ))}
        </nav>

        {/* HISTORY */}

        {!collapsed ? (
          <div className="mt-7 min-h-0 flex-1 overflow-y-auto px-1">
            <ConversationSection
              title="Pinned"
              items={pinnedChats}
              theme={theme}
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
            />

            <ConversationSection
              title="Recent"
              items={recentChats}
              theme={theme}
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
              className="mt-7"
            />
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {/* ACCOUNT ONLY */}

        <div
          className={cn(
            collapsed
              ? "mt-3 border-t px-0 pt-2"
              : "mt-4 border-t pt-3",
            theme === "dark"
              ? "border-white/[0.06]"
              : "border-black/[0.08]",
          )}
        >
          <AccountMenu
            collapsed={collapsed}
            theme={theme}
            onNavigate={onNavigate}
          />
        </div>
      </div>
    </motion.aside>
  );
}

/* ------------------------------------------------ */
/* SIDEBAR BUTTON */
/* ------------------------------------------------ */

function SidebarAction({
  icon: Icon,
  label,
  collapsed,
  theme,
  active = false,
  shortcut,
  onClick,
}: {
  icon: ComponentType<{
    size?: number;
  }>;

  label: string;
  collapsed: boolean;
  theme: Theme;

  active?: boolean;
  shortcut?: string;

  onClick: () => void;
}) {
  const [hovered, setHovered] =
    useState(false);

  return (
    <div className="relative">
      <motion.button
        type="button"
        onMouseEnter={() =>
          setHovered(true)
        }
        onMouseLeave={() =>
          setHovered(false)
        }
        onClick={onClick}
        whileHover={
          collapsed
            ? {
                scale: 1.08,
                y: -1,
              }
            : {
                x: 2,
                scale: 1.005,
              }
        }
        whileTap={{
          scale: 0.96,
        }}
        transition={{
          type: "spring",
          stiffness: 430,
          damping: 28,
        }}
        className={cn(
          "flex h-[42px] w-full items-center rounded-[11px] text-[13px] font-normal",

          collapsed
            ? "mx-auto h-10 w-10 justify-center"
            : "gap-3 px-3",

          active
            ? theme === "dark"
              ? "bg-[#2a2a2a] text-white"
              : "bg-black/[0.07] text-black"
            : theme === "dark"
              ? "text-zinc-400 hover:bg-[#303030] hover:text-white"
              : "text-zinc-600 hover:bg-black/[0.055] hover:text-black",
        )}
      >
        <motion.span
          animate={{
            scale: hovered ? 1.08 : 1,
          }}
          transition={{
            duration: 0.14,
          }}
          className="flex shrink-0 items-center justify-center"
        >
          <Icon size={18} />
        </motion.span>

        {!collapsed ? (
          <>
            <span className="flex-1 text-left font-normal">
              {label}
            </span>

            {shortcut ? (
              <span
                className={cn(
                  "rounded-[6px] border px-1.5 py-0.5 text-[9px]",

                  theme === "dark"
                    ? "border-white/[0.08] text-zinc-600"
                    : "border-black/[0.09] text-zinc-400",
                )}
              >
                {shortcut}
              </span>
            ) : null}
          </>
        ) : null}
      </motion.button>

      <AnimatePresence>
        {collapsed && hovered ? (
          <motion.div
            initial={{
              opacity: 0,
              x: -5,
              scale: 0.97,
            }}
            animate={{
              opacity: 1,
              x: 0,
              scale: 1,
            }}
            exit={{
              opacity: 0,
              x: -4,
              scale: 0.97,
            }}
            transition={{
              duration: 0.13,
            }}
            className="pointer-events-none absolute left-[48px] top-1/2 z-[300] -translate-y-1/2 whitespace-nowrap rounded-[9px] border border-white/[0.08] bg-[#303030] px-3 py-2 text-[12px] font-medium text-white shadow-xl"
          >
            {label}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------ */
/* COLLAPSED BRAND / OPEN SIDEBAR */
/* ------------------------------------------------ */

function CollapsedBrandButton({
  theme,
  onClick,
}: {
  theme: Theme;
  onClick: () => void;
}) {
  const [hovered, setHovered] =
    useState(false);

  return (
    <div className="relative">
      <motion.button
        type="button"
        aria-label="Open sidebar"
        onClick={onClick}
        onMouseEnter={() =>
          setHovered(true)
        }
        onMouseLeave={() =>
          setHovered(false)
        }
        whileHover={{
          scale: 1.09,
          y: -1,
        }}
        whileTap={{
          scale: 0.94,
        }}
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-[11px]",
          theme === "dark"
            ? "hover:bg-[#303030]"
            : "hover:bg-black/[0.055]",
        )}
      >
        <ClawbitMark
          className={cn(
            "h-[22px] w-[22px]",
            theme === "dark"
              ? "text-white"
              : "text-black",
          )}
        />
      </motion.button>

      <AnimatePresence>
        {hovered ? (
          <motion.div
            initial={{
              opacity: 0,
              x: -4,
              scale: 0.97,
            }}
            animate={{
              opacity: 1,
              x: 0,
              scale: 1,
            }}
            exit={{
              opacity: 0,
              x: -3,
              scale: 0.97,
            }}
            transition={{
              duration: 0.13,
            }}
            className="pointer-events-none absolute left-[48px] top-1/2 z-[300] -translate-y-1/2 whitespace-nowrap rounded-[9px] border border-white/[0.08] bg-[#303030] px-3 py-2 text-[12px] font-medium text-white shadow-xl"
          >
            Open sidebar
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------ */
/* COLLAPSE BUTTON */
/* ------------------------------------------------ */

function SidebarIconButton({
  icon: Icon,
  label,
  theme,
  onClick,
}: {
  icon: ComponentType<{
    size?: number;
  }>;

  label: string;
  theme: Theme;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      title={label}
      whileHover={{
        scale: 1.05,
      }}
      whileTap={{
        scale: 0.94,
      }}
      onClick={onClick}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-[11px]",

        theme === "dark"
          ? "text-zinc-500 hover:bg-[#2d2d2d] hover:text-white"
          : "text-zinc-500 hover:bg-black/[0.055] hover:text-black",
      )}
    >
      <Icon size={18} />
    </motion.button>
  );
}

/* ------------------------------------------------ */
/* CHAT LIST */
/* ------------------------------------------------ */

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

  items: SidebarConversation[];

  theme: Theme;

  activeConversationId:
    | string
    | null;

  onOpenConversation:
    (id: string) => void;

  onTogglePinConversation:
    (id: string) => void;

  onDeleteConversation:
    (id: string) => void;

  onRenameConversation: (
    id: string,
    title: string,
  ) => void;

  className?: string;
}) {
  const [
    editingId,
    setEditingId,
  ] = useState<
    string | null
  >(null);

  const [
    draftTitle,
    setDraftTitle,
  ] = useState("");

  if (items.length === 0) {
    return null;
  }

  function startRename(
    item: SidebarConversation,
  ) {
    setEditingId(item.id);
    setDraftTitle(item.title);
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

    setEditingId(null);
    setDraftTitle("");
  }

  return (
    <section className={className}>
      <p
        className={cn(
          "mb-2 px-2 text-[11px] font-medium",

          theme === "dark"
            ? "text-zinc-500"
            : "text-zinc-400",
        )}
      >
        {title}
      </p>

      <div className="space-y-[2px]">
        {items.map((item) => {
          const active =
            activeConversationId ===
            item.id;

          const editing =
            editingId === item.id;

          return (
            <div
              key={item.id}
              className={cn(
                "group flex h-[38px] items-center rounded-[10px] px-2",

                active
                  ? theme === "dark"
                    ? "bg-[#2a2a2a]"
                    : "bg-black/[0.07]"
                  : theme === "dark"
                    ? "hover:bg-[#2d2d2d]"
                    : "hover:bg-black/[0.05]",
              )}
            >
              {editing ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(event) =>
                    setDraftTitle(
                      event.target.value,
                    )
                  }
                  onBlur={() =>
                    finishRename(
                      item.id,
                    )
                  }
                  onKeyDown={(event) => {
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
                    }
                  }}
                  className={cn(
                    "min-w-0 flex-1 rounded-[7px] border px-2 py-1 text-[13px] font-normal outline-none",

                    theme === "dark"
                      ? "border-white/[0.12] bg-[#202020] text-white"
                      : "border-black/[0.12] bg-white text-black",
                  )}
                />
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    onOpenConversation(
                      item.id,
                    )
                  }
                  className={cn(
                    "min-w-0 flex-1 truncate text-left text-[13px] font-normal",

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
                  {item.title}
                </button>
              )}

              {!editing ? (
                <ConversationMenu
                  item={item}
                  theme={theme}
                  onRename={() =>
                    startRename(item)
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
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------ */
/* THREE DOT CHAT MENU */
/* ------------------------------------------------ */

function ConversationMenu({
  item,
  theme,
  onRename,
  onTogglePin,
  onDelete,
}: {
  item: SidebarConversation;
  theme: Theme;

  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] =
    useState(false);

  async function shareConversation() {
    const url =
      window.location.href;

    try {
      if (navigator.share) {
        await navigator.share({
          title: item.title,
          text: item.preview,
          url,
        });

        return;
      }

      await navigator.clipboard.writeText(
        url,
      );
    } catch {
      // User cancelled sharing.
    }
  }

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={setOpen}
    >
      <DropdownMenu.Trigger
        asChild
      >
        <button
          type="button"
          aria-label="Conversation options"
          className={cn(
            "ml-1 h-7 w-7 shrink-0 items-center justify-center rounded-[7px]",
            open
              ? "flex"
              : "hidden group-hover:flex",

            theme === "dark"
              ? "text-zinc-500 hover:bg-white/[0.08] hover:text-white"
              : "text-zinc-400 hover:bg-black/[0.07] hover:text-black",
          )}
        >
          <MoreHorizontal
            size={17}
          />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="center"
          sideOffset={8}
          collisionPadding={10}
          className={cn(
            "z-[400] w-[210px] rounded-[16px] border p-1.5 shadow-[0_24px_70px_rgba(0,0,0,0.6)]",

            theme === "dark"
              ? "border-white/[0.08] bg-[#2b2b2b] text-white"
              : "border-black/[0.10] bg-white text-black",
          )}
        >
          <ConversationMenuItem
            icon={Share2}
            label="Share conversation"
            theme={theme}
            onSelect={() =>
              void shareConversation()
            }
          />

          <ConversationMenuItem
            icon={Pin}
            label={
              item.pinned
                ? "Unpin"
                : "Pin"
            }
            theme={theme}
            onSelect={onTogglePin}
          />

          <ConversationMenuItem
            icon={Pencil}
            label="Rename"
            theme={theme}
            onSelect={onRename}
          />

          <div
            className={cn(
              "my-1 border-t",
              theme === "dark"
                ? "border-white/[0.08]"
                : "border-black/[0.08]",
            )}
          />

          <ConversationMenuItem
            icon={Trash2}
            label="Delete"
            theme={theme}
            destructive
            onSelect={onDelete}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ConversationMenuItem({
  icon: Icon,
  label,
  theme,
  destructive = false,
  onSelect,
}: {
  icon: ComponentType<{
    size?: number;
  }>;

  label: string;
  theme: Theme;
  destructive?: boolean;

  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2.5 text-[13px] outline-none",

        destructive
          ? "text-red-400 hover:bg-red-500/[0.08] focus:bg-red-500/[0.08]"
          : theme === "dark"
            ? "text-zinc-200 hover:bg-white/[0.07] focus:bg-white/[0.07]"
            : "text-zinc-700 hover:bg-black/[0.05] focus:bg-black/[0.05]",
      )}
    >
      <Icon size={16} />

      {label}
    </DropdownMenu.Item>
  );
}

/* ------------------------------------------------ */
/* ACCOUNT */
/* ------------------------------------------------ */

function AccountMenu({
  collapsed,
  theme,
  onNavigate,
}: {
  collapsed: boolean;
  theme: Theme;

  onNavigate:
    (view: AppView) => void;
}) {
  const [open, setOpen] =
    useState(false);

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={setOpen}
    >
      <DropdownMenu.Trigger
        asChild
      >
        <button
          type="button"
          className={cn(
            "mt-1 flex w-full items-center rounded-[12px]",

            collapsed
              ? "mx-auto h-10 w-10 justify-center"
              : "min-h-[58px] gap-3 px-2.5",

            open
              ? theme === "dark"
                ? "bg-[#2d2d2d]"
                : "bg-black/[0.06]"
              : theme === "dark"
                ? "hover:bg-[#2d2d2d]"
                : "hover:bg-black/[0.05]",
          )}
        >
          <UserAvatar />

          {!collapsed ? (
            <>
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-[13px] font-medium">
                  Hassan Kadri
                </p>

                <p className="mt-0.5 text-[10px] text-zinc-500">
                  Personal
                </p>
              </div>

              <MoreHorizontal
                size={16}
                className="text-zinc-500"
              />
            </>
          ) : null}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="center"
          sideOffset={8}
          className={cn(
            "z-[400] w-[270px] rounded-[18px] border p-2 shadow-[0_24px_80px_rgba(0,0,0,0.7)]",

            theme === "dark"
              ? "border-white/[0.08] bg-[#2b2b2b] text-white"
              : "border-black/[0.10] bg-white text-black",
          )}
        >
          <div className="flex items-center gap-3 px-2.5 py-2.5">
            <UserAvatar />

            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium">
                Hassan Kadri
              </p>

              <p className="mt-0.5 text-[11px] text-zinc-500">
                Personal
              </p>
            </div>
          </div>

          <MenuDivider
            theme={theme}
          />

          <AccountMenuItem
            icon={SlidersHorizontal}
            label="Personalization"
            theme={theme}
            onSelect={() =>
              onNavigate(
                "customize",
              )
            }
          />

          <AccountMenuItem
            icon={UserRound}
            label="Profile"
            theme={theme}
            onSelect={() =>
              onNavigate(
                "customize",
              )
            }
          />

          <AccountMenuItem
            icon={Settings2}
            label="Settings"
            theme={theme}
            onSelect={() =>
              onNavigate(
                "settings",
              )
            }
          />

          <MenuDivider
            theme={theme}
          />

          <AccountMenuItem
            icon={CircleHelp}
            label="Help"
            theme={theme}
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
  icon: Icon,
  label,
  theme,
  onSelect,
}: {
  icon: ComponentType<{
    size?: number;
  }>;

  label: string;
  theme: Theme;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2.5 text-[13px] outline-none",

        theme === "dark"
          ? "text-zinc-200 hover:bg-white/[0.07] focus:bg-white/[0.07]"
          : "text-zinc-700 hover:bg-black/[0.05] focus:bg-black/[0.05]",
      )}
    >
      <Icon size={16} />

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
          ? "border-white/[0.08]"
          : "border-black/[0.08]",
      )}
    />
  );
}