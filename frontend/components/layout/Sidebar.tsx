"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FolderKanban,
  MessageSquare,
  Palette,
  Pin,
  Plus,
  PlugZap,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useState } from "react";

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
}

const navigationItems = [
  { id: "chats", label: "Chats", icon: MessageSquare },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "plugins", label: "Plugins", icon: PlugZap },
  { id: "customize", label: "Customize", icon: Palette },
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
}: SidebarProps) {
  return (
    <motion.aside
      layout
      initial={false}
      animate={{ width: collapsed ? 80 : 252 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className={cn(
        "ui-surface-elevated relative m-4 hidden shrink-0 overflow-hidden xl:flex dark:border-white/[0.04] dark:bg-[#0e1116] dark:shadow-[0_12px_28px_rgba(0,0,0,0.12)]",
        theme === "dark" ? "text-white" : "text-slate-900",
      )}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-32 blur-3xl",
          theme === "dark" ? "bg-white/[0.018]" : "bg-violet-200/40",
        )}
      />

      <div className="relative flex h-full w-full flex-col px-3.5 pb-3.5 pt-[18px]">
        <div className="flex items-center justify-between px-0.5">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <AnimatePresence initial={false}>
              {collapsed ? (
                <motion.div
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.18 }}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#12161c] shadow-none"
                >
                  <ClawbitMark
                    className={cn(
                      "h-5 w-5",
                      theme === "dark" ? "text-white" : "text-slate-900",
                    )}
                  />
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.18 }}
                  className="min-w-0"
                >
                  <ClawbitMark
                    variant="horizontal"
                    iconClassName={cn(
                      "h-5 w-5",
                      theme === "dark" ? "text-white" : "text-slate-900",
                    )}
                    wordmarkClassName={cn(
                      "text-[17px] leading-none",
                      theme === "dark" ? "text-white" : "text-slate-900",
                    )}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <button
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "ui-icon-button shrink-0",
              theme === "dark"
                ? "text-zinc-500 hover:text-white"
                : "text-slate-400 hover:text-slate-900",
            )}
          >
            {collapsed ? (
              <ChevronRight size={18} />
            ) : (
              <ChevronLeft size={18} />
            )}
          </button>
        </div>

        <SidebarAction
          label="New chat"
          tooltip="New chat"
          icon={Plus}
          theme={theme}
          collapsed={collapsed}
          className="mt-5"
          onClick={onNewChat}
          accent
        />

        <SidebarAction
          label="Search chats"
          tooltip="Search chats"
          icon={Search}
          theme={theme}
          collapsed={collapsed}
          className="mt-3.5"
          onClick={onOpenCommandPalette}
        />

        <nav className="mt-4 space-y-1.5">
          {navigationItems.map((item) => (
            <SidebarNavButton
              key={item.id}
              icon={item.icon}
              label={item.label}
              tooltip={item.label}
              theme={theme}
              collapsed={collapsed}
              active={activeView === item.id}
              onClick={() => onNavigate(item.id)}
            />
          ))}
        </nav>

        <AnimatePresence initial={false}>
          {!collapsed ? (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              className="mt-6 flex-1 overflow-y-auto pr-1"
            >
              <ConversationSection
                title="Pinned"
                theme={theme}
                items={pinnedChats}
                activeConversationId={activeConversationId}
                onOpenConversation={onOpenConversation}
                onTogglePinConversation={onTogglePinConversation}
                onDeleteConversation={onDeleteConversation}
              />

              <ConversationSection
                title="Recent"
                theme={theme}
                className="mt-6"
                items={recentChats}
                activeConversationId={activeConversationId}
                onOpenConversation={onOpenConversation}
                onTogglePinConversation={onTogglePinConversation}
                onDeleteConversation={onDeleteConversation}
              />
            </motion.div>
          ) : (
            <div className="flex-1" />
          )}
        </AnimatePresence>

        <div
          className={cn(
            "mt-4 border-t pt-4",
            theme === "dark" ? "border-white/[0.04]" : "border-[color:var(--border)]",
          )}
        >
          <SidebarNavButton
            icon={Settings2}
            label="Settings"
            tooltip="Settings"
            theme={theme}
            collapsed={collapsed}
            active={activeView === "settings"}
            onClick={() => onNavigate("settings")}
          />
          <SidebarNavButton
            icon={CircleHelp}
            label="Help & Docs"
            tooltip="Help & Docs"
            theme={theme}
            collapsed={collapsed}
            active={activeView === "help"}
            onClick={() => onNavigate("help")}
            className="mt-1"
          />

          <div
            className={cn(
              "ui-card mt-4 p-3 dark:rounded-[12px]",
              theme === "dark"
                ? "border-white/[0.04] bg-[#12161c] shadow-none"
                : "",
            )}
          >
            <div
              className={cn(
                "flex items-center",
                collapsed ? "justify-center" : "gap-3",
              )}
            >
              <UserAvatar />
              {!collapsed ? (
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold">
                    Amaan Kadri
                  </p>
                  <p className="text-[12px] text-zinc-400">Free plan</p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </motion.aside>
  );
}

function SidebarNavButton({
  icon: Icon,
  label,
  tooltip,
  theme,
  collapsed,
  active,
  onClick,
  className,
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  tooltip: string;
  theme: Theme;
  collapsed: boolean;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <motion.button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      whileHover="hover"
      whileTap={{ scale: 0.985 }}
      initial={false}
      animate={active ? "active" : "rest"}
        className={cn(
          "group relative flex h-[38px] w-full items-center overflow-hidden rounded-[12px] px-3 text-[14px] font-medium outline-none",
        collapsed ? "justify-center px-0" : "justify-start gap-3",
          theme === "dark"
            ? "text-zinc-300 hover:text-white"
            : "text-slate-600 hover:text-slate-900",
        className,
      )}
    >
      <motion.span
        variants={{
          rest: { opacity: active ? 1 : 0, scaleX: active ? 1 : 0.97 },
          hover: { opacity: 1, scaleX: 1 },
          active: { opacity: 1, scaleX: 1 },
        }}
        transition={{ duration: 0.18 }}
        className={cn(
          "absolute inset-0 origin-left rounded-[14px]",
          active
            ? "bg-white/[0.03] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
            : theme === "dark"
              ? "bg-transparent"
              : "bg-slate-100",
        )}
      />

        {active ? (
          <motion.span
            layoutId="sidebar-active-indicator"
            className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-violet-400/70"
          />
        ) : null}

      <motion.span
        variants={{
          rest: { x: 0, scale: 1 },
          hover: { x: 0, scale: 1.04 },
          active: { x: 0, scale: 1.04 },
        }}
        className={cn(
          "relative z-10 flex items-center justify-center",
          collapsed ? "w-full" : "",
          active ? "text-violet-400/80" : "",
        )}
      >
        <Icon size={18} />
      </motion.span>

      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.span
            variants={{
              rest: { x: 0 },
              hover: { x: 2 },
              active: { x: 2 },
            }}
            className="relative z-10"
          >
            {label}
          </motion.span>
        ) : null}
      </AnimatePresence>

      {collapsed && hovered ? (
        <motion.span
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -4 }}
          transition={{ duration: 0.14 }}
          className={cn(
            "pointer-events-none absolute left-full top-1/2 z-20 ml-3 -translate-y-1/2 whitespace-nowrap rounded-[10px] border px-2.5 py-1 text-[12px] shadow-[0_8px_16px_rgba(0,0,0,0.1)]",
            theme === "dark"
              ? "border-white/[0.04] bg-[#11151b] text-white"
              : "border-[color:var(--border)] bg-white text-slate-900",
          )}
        >
          {tooltip}
        </motion.span>
      ) : null}
    </motion.button>
  );
}

function SidebarAction({
  icon: Icon,
  label,
  tooltip,
  theme,
  collapsed,
  onClick,
  className,
  accent = false,
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  tooltip: string;
  theme: Theme;
  collapsed: boolean;
  onClick: () => void;
  className?: string;
  accent?: boolean;
}) {
  return (
    <SidebarNavButton
      icon={Icon}
      label={label}
      tooltip={tooltip}
      theme={theme}
      collapsed={collapsed}
      active={false}
      onClick={onClick}
        className={cn(
          className,
          accent
            ? theme === "dark"
            ? "border border-white/[0.04] bg-[#12161c] text-white shadow-none hover:bg-[#171b22] hover:text-white"
            : "bg-violet-100 text-slate-900 shadow-[0_10px_24px_rgba(139,92,246,0.08)] hover:text-slate-900"
            : "",
        )}
      />
  );
}

function ConversationSection({
  title,
  items,
  theme,
  activeConversationId,
  onOpenConversation,
  onTogglePinConversation,
  onDeleteConversation,
  className,
}: {
  title: string;
  items: SidebarConversation[];
  theme: Theme;
  activeConversationId: string | null;
  onOpenConversation: (id: string) => void;
  onTogglePinConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p
        className={cn(
          "mb-3 text-[11px] font-semibold uppercase tracking-[0.22em]",
          theme === "dark" ? "text-zinc-500" : "text-slate-400",
        )}
      >
        {title}
      </p>

      <div className="space-y-2">
        {items.length > 0 ? (
          items.map((item) => (
            <div
              key={item.id}
              className={cn(
                "group flex w-full items-start gap-3 rounded-[12px] border px-3 py-2.5 text-left text-[14px] transition",
                activeConversationId === item.id
                  ? theme === "dark"
                    ? "border-white/[0.04] bg-white/[0.03] text-white shadow-none"
                    : "border-violet-500/18 bg-violet-50 text-slate-900 shadow-[0_10px_20px_rgba(139,92,246,0.06)]"
                  : theme === "dark"
                    ? "border-transparent text-zinc-300 hover:border-white/[0.04] hover:bg-white/[0.025] hover:text-white"
                    : "border-transparent text-slate-600 hover:border-[color:var(--border)] hover:bg-slate-100 hover:text-slate-900",
              )}
            >
              <button
                type="button"
                onClick={() => onOpenConversation(item.id)}
                className="flex min-w-0 flex-1 items-start gap-3 text-left"
              >
                <div
                  className={cn(
                    "mt-0.5 shrink-0 rounded-[12px] p-2",
                    activeConversationId === item.id
                      ? "bg-white/[0.04] text-violet-400/80"
                      : theme === "dark"
                        ? "bg-[#12161c] text-violet-400/80"
                        : "bg-[color:var(--accent-hover)] text-violet-500",
                  )}
                >
                  <MessageSquare size={14} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <p className="truncate text-[14px] font-medium leading-5">
                      {item.title}
                    </p>
                    {item.pinned ? (
                      <Pin size={14} className="mt-0.5 shrink-0 text-violet-400" />
                    ) : null}
                  </div>
                  <p
                    className={cn(
                      "mt-1 line-clamp-2 text-[13px] leading-5",
                      theme === "dark" ? "text-zinc-500" : "text-slate-500",
                    )}
                  >
                    {item.preview}
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onTogglePinConversation(item.id);
                }}
                className={cn(
                  "mt-0.5 rounded-[12px] p-1.5 transition",
                  theme === "dark"
                    ? "text-zinc-500 hover:bg-white/[0.025] hover:text-white"
                    : "text-slate-400 hover:bg-slate-100 hover:text-slate-900",
                )}
                aria-label={item.pinned ? "Unpin chat" : "Pin chat"}
              >
                <Pin size={14} className={item.pinned ? "text-violet-400" : ""} />
              </button>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteConversation(item.id);
                }}
                className={cn(
                  "mt-0.5 rounded-[12px] p-1.5 transition",
                  theme === "dark"
                    ? "text-zinc-500 hover:bg-white/[0.03] hover:text-white"
                    : "text-slate-400 hover:bg-slate-100 hover:text-slate-900",
                )}
                aria-label="Delete chat"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        ) : (
          <div
            className={cn(
              "rounded-[14px] border px-3 py-4 text-[13px]",
              theme === "dark"
                ? "border-white/[0.04] bg-[#11151b] text-zinc-500"
                : "border-[color:var(--border)] bg-white text-slate-500",
            )}
          >
            No {title.toLowerCase()} chats yet.
          </div>
        )}
      </div>
    </div>
  );
}
