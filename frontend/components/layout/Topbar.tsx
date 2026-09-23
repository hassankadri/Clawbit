"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  CheckCheck,
  CreditCard,
  FolderKanban,
  Keyboard,
  LogOut,
  Moon,
  Palette,
  Settings2,
  Sparkles,
  Sun,
  UserCircle2,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";
import { forwardRef, useMemo, useState } from "react";

import UserAvatar from "@/components/common/UserAvatar";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface NotificationItem {
  id: string;
  title: string;
  detail: string;
  read: boolean;
}

type AppView =
  | "chats"
  | "projects"
  | "plugins"
  | "customize"
  | "settings"
  | "help";

interface TopbarProps {
  theme: Theme;
  activeView: AppView;
  notifications: NotificationItem[];
  onMarkAllRead: () => void;
  onNavigate: (view: AppView) => void;
}

const themeModes = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
] as const;

const profileItems = [
  { label: "Workspace", icon: FolderKanban, view: "projects" as const },
  { label: "Profile", icon: UserCircle2, view: "customize" as const },
  { label: "Billing", icon: CreditCard, view: "settings" as const },
  { label: "Models", icon: Sparkles, view: "settings" as const },
  { label: "Appearance", icon: Palette, view: "settings" as const },
  { label: "Settings", icon: Settings2, view: "settings" as const },
  { label: "Keyboard shortcuts", icon: Keyboard, view: "help" as const },
  { label: "Logout", icon: LogOut, view: "help" as const },
] as const;

const planCards = [
  {
    title: "Pro",
    body: "More uploads, larger context, and premium models.",
  },
  {
    title: "Max",
    body: "Best for advanced reasoning and heavy daily use.",
  },
] as const;

export default function Topbar({
  theme,
  activeView,
  notifications,
  onMarkAllRead,
  onNavigate,
}: TopbarProps) {
  const { setTheme } = useTheme();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const unreadNotifications = useMemo(
    () => notifications.filter((item) => !item.read),
    [notifications],
  );
  const aiUpdates = useMemo(
    () => [
      {
        id: "gpt-55",
        title: "OpenAI releases GPT-5.5",
        detail:
          "The new release emphasizes faster reasoning, improved instruction following, and broader tool use.",
        time: "2h ago",
      },
      {
        id: "sonnet-45",
        title: "Anthropic announces Claude Sonnet 4.5",
        detail:
          "Anthropic highlights stronger long-context performance and more reliable agent workflows.",
        time: "5h ago",
      },
      {
        id: "gemini-3",
        title: "Google introduces Gemini 3",
        detail:
          "Google positions the new Gemini release around multimodal capability and lower latency.",
        time: "1d ago",
      },
    ],
    [],
  );

  return (
    <header className="relative z-10 flex h-16 items-center justify-end px-5 pt-3 lg:px-7">
      <div
        className={cn(
          "flex items-center gap-2 rounded-[22px] border px-2.5 py-2 shadow-none backdrop-blur-2xl",
          theme === "dark"
            ? "border-white/[0.04] bg-[color:var(--surface)]/94"
            : "border-slate-300 bg-[color:var(--panel)]/96",
        )}
      >
        <AnimatePresence initial={false}>
          {activeView !== "chats" && activeView !== "settings" ? (
            <motion.button
              type="button"
              onClick={() => onNavigate("chats")}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.985 }}
              transition={{ type: "spring", stiffness: 360, damping: 30 }}
              aria-label="Close panel"
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-[14px] border transition",
                theme === "dark"
                  ? "border-white/[0.04] bg-[color:var(--surface)] text-zinc-300 hover:text-white"
                  : "border-slate-300 bg-[color:var(--card)] text-slate-600 hover:border-violet-300 hover:bg-violet-50 hover:text-slate-950",
              )}
            >
              <X size={18} />
            </motion.button>
          ) : null}
        </AnimatePresence>

        <ThemeSwitcher
          theme={theme}
          activeTheme={theme}
          onChange={setTheme}
        />

        <DropdownMenu.Root
          open={notificationsOpen}
          onOpenChange={setNotificationsOpen}
        >
          <DropdownMenu.Trigger asChild>
            <TopbarButton theme={theme} label="Notifications">
              <span className="relative flex h-8 w-8 items-center justify-center">
                <Bell size={17} />
                {aiUpdates.length > 0 ? (
                  <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white/[0.08] px-1 text-[10px] font-semibold text-zinc-100">
                    {Math.min(9, aiUpdates.length)}
                  </span>
                ) : null}
              </span>
            </TopbarButton>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              forceMount
              sideOffset={12}
              align="end"
              className="ui-menu-surface z-50 w-[360px] p-2 text-[color:var(--foreground)]"
              style={{
                opacity: notificationsOpen ? 1 : 0,
                transform: notificationsOpen
                  ? "translateY(0px) scale(1)"
                  : "translateY(-8px) scale(0.98)",
                pointerEvents: notificationsOpen ? "auto" : "none",
                transition: "opacity 160ms ease, transform 160ms ease",
              }}
            >
              <div className="flex items-center justify-between px-3 py-2">
                <div>
                  <p className="text-[14px] font-semibold">Notifications</p>
                  <p
                    className={cn(
                      "text-[13px]",
                      theme === "dark" ? "text-zinc-400" : "text-slate-500",
                    )}
                  >
                    Product updates and workspace activity
                  </p>
                </div>
                <button
                  onClick={onMarkAllRead}
                  disabled={unreadNotifications.length === 0}
                  className="inline-flex items-center gap-2 rounded-[14px] px-3 py-2 text-[13px] font-medium text-violet-400 hover:bg-[color:var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <CheckCheck size={14} />
                  Mark all read
                </button>
              </div>

              <div className="mt-1 space-y-2">
                {aiUpdates.map((item) => (
                  <NotificationCard
                    key={item.id}
                    title={item.title}
                    detail={item.detail}
                    time={item.time}
                    theme={theme}
                  />
                ))}
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <DropdownMenu.Root open={profileOpen} onOpenChange={setProfileOpen}>
          <DropdownMenu.Trigger asChild>
            <TopbarButton theme={theme} label="Account">
              <UserAvatar size="sm" />
            </TopbarButton>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              forceMount
              sideOffset={12}
              align="end"
              className="ui-menu-surface z-50 w-[300px] p-2 text-[color:var(--foreground)]"
              style={{
                opacity: profileOpen ? 1 : 0,
                transform: profileOpen
                  ? "translateY(0px) scale(1)"
                  : "translateY(-8px) scale(0.98)",
                pointerEvents: profileOpen ? "auto" : "none",
                transition: "opacity 160ms ease, transform 160ms ease",
              }}
            >
              <div className="px-3 py-2">
                <p className="text-[14px] font-semibold">Amaan Kadri</p>
                <p
                  className={cn(
                    "text-[13px]",
                    theme === "dark" ? "text-zinc-400" : "text-slate-500",
                  )}
                >
                  Free plan
                </p>
              </div>

              <div className="mx-2 my-2 rounded-[16px] border border-white/[0.04] bg-[color:var(--surface)] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-semibold text-violet-500">
                      Upgrade to Pro
                    </p>
                    <p
                      className={cn(
                        "mt-1 text-[12px] leading-5",
                        theme === "dark" ? "text-zinc-400" : "text-slate-500",
                      )}
                  >
                    More uploads, better models, and longer context.
                  </p>
                </div>
                <button
                  onClick={() => onNavigate("settings")}
                  className="rounded-[14px] bg-[color:var(--accent-hover)] px-3 py-2 text-[12px] font-medium text-violet-400"
                >
                  Upgrade
                </button>
              </div>

              <div className="mt-3 grid gap-2">
                {planCards.map((plan) => (
                  <div
                    key={plan.title}
                    className={cn(
                      "rounded-[14px] border px-3 py-3",
                      theme === "dark"
                      ? "border-white/[0.04] bg-white/[0.02]"
                        : "border-slate-300 bg-[color:var(--panel)]",
                    )}
                  >
                    <p className="text-[13px] font-medium">{plan.title}</p>
                    <p
                      className={cn(
                        "mt-1 text-[12px] leading-5",
                        theme === "dark" ? "text-zinc-400" : "text-slate-500",
                      )}
                    >
                      {plan.body}
                    </p>
                  </div>
                ))}
              </div>
            </div>

              <div className="my-1 border-t border-white/[0.04]" />

              {profileItems.map((item) => {
                const Icon = item.icon;
                const selectHandler =
                  item.label === "Profile"
                    ? () => onNavigate("customize")
                    : item.label === "Settings"
                      ? () => onNavigate("settings")
                      : item.label === "Appearance"
                        ? () => {
                            setTheme(theme === "dark" ? "light" : "dark");
                          }
                        : () => undefined;

                return (
                  <MenuAction
                    key={item.label}
                    icon={Icon}
                    label={item.label}
                    theme={theme}
                    onSelect={selectHandler}
                  />
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}

type TopbarButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  theme: Theme;
  label: string;
  children: React.ReactNode;
};

const TopbarButton = forwardRef<HTMLButtonElement, TopbarButtonProps>(
  function TopbarButton({ children, theme, label, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-[12px] border transition hover:-translate-y-px hover:shadow-none",
        theme === "dark"
          ? "border-white/[0.04] bg-[color:var(--surface)] text-zinc-300 hover:text-white"
          : "border-slate-300 bg-[color:var(--card)] text-slate-600 hover:border-violet-300 hover:bg-violet-50 hover:text-slate-950",
        className,
      )}
    >
      {children}
    </button>
  );
});

function ThemeSwitcher({
  theme,
  activeTheme,
  onChange,
}: {
  theme: Theme;
  activeTheme: "light" | "dark";
  onChange: (theme: "light" | "dark") => void;
}) {
  const activeIndex = themeModes.findIndex(
    (mode) => activeTheme === mode.id,
  );

  return (
    <div
      className={cn(
        "relative flex h-8 w-[124px] items-stretch rounded-[14px] border p-1",
        theme === "dark"
          ? "border-white/[0.04] bg-[color:var(--card)]"
          : "border-slate-300 bg-[color:var(--card)]",
      )}
    >
      <motion.div
        initial={false}
        animate={{
          left: `calc(${activeIndex * 50}% + 4px)`,
        }}
        transition={{ type: "spring", stiffness: 360, damping: 30 }}
        className={cn(
          "absolute top-1 bottom-1 rounded-[11px] shadow-none",
          theme === "dark" ? "bg-[#171a20]" : "bg-slate-100",
        )}
          style={{
            width: "calc(50% - 0.5rem)",
          }}
      />

      {themeModes.map((mode) => {
        const Icon = mode.icon;
        const active = activeTheme === mode.id;

        return (
          <button
            key={mode.id}
            type="button"
            title={mode.label}
            onClick={() => onChange(mode.id)}
            className={cn(
              "relative z-10 flex flex-1 items-center justify-center gap-1 rounded-[12px] text-[11px] font-medium transition",
              active
                ? "text-violet-500"
                : theme === "dark"
                  ? "text-zinc-400"
                  : "text-slate-500",
            )}
          >
            <Icon size={14} />
            <span>{mode.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function NotificationCard({
  title,
  detail,
  time,
  theme,
}: {
  title: string;
  detail: string;
  time: string;
  theme: Theme;
}) {
  return (
    <div
      className={cn(
        "rounded-[16px] border px-3 py-3 dark:rounded-[14px]",
        theme === "dark"
            ? "border-white/[0.04] bg-white/[0.02]"
            : "border-slate-300 bg-[color:var(--panel)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] font-medium leading-6">{title}</p>
          <p
            className={cn(
              "mt-1 text-[13px] leading-6",
              theme === "dark" ? "text-zinc-400" : "text-slate-500",
            )}
          >
            {detail}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]",
            theme === "dark"
              ? "bg-white/[0.08] text-zinc-100"
              : "bg-slate-100 text-slate-500",
          )}
        >
          {time}
        </span>
      </div>

      <button
        type="button"
        className={cn(
          "mt-3 inline-flex items-center rounded-[12px] px-3 py-2 text-[12px] font-medium transition hover:-translate-y-px",
          theme === "dark"
            ? "bg-white/[0.04] text-white hover:bg-white/[0.06]"
            : "bg-slate-200 text-slate-800 hover:bg-slate-300",
        )}
      >
        Read More
      </button>
    </div>
  );
}

function MenuAction({
  icon: Icon,
  label,
  theme,
  onSelect,
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  theme: Theme;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-[14px] px-3 py-2.5 text-[14px] outline-none transition",
        theme === "dark"
          ? "text-zinc-300 hover:bg-white/[0.04]"
          : "text-slate-700 hover:bg-violet-50 hover:text-slate-950",
      )}
    >
      <Icon size={18} />
      {label}
    </DropdownMenu.Item>
  );
}
