"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import {
  Bell,
  CheckCheck,
  FolderKanban,
  Moon,
  Settings2,
  Sun,
  UserCircle2,
  X,
} from "lucide-react";

import { useTheme } from "next-themes";

import {
  useMemo,
  useState,
} from "react";

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

  onNavigate: (
    view: AppView
  ) => void;
}


const viewLabels: Record<
  AppView,
  string
> = {
  chats: "Clawbit",

  projects: "Workspaces",

  plugins: "Tools",

  customize: "Customize",

  settings: "Settings",

  help: "Help",
};


export default function Topbar({
  theme,

  activeView,

  notifications,

  onMarkAllRead,

  onNavigate,
}: TopbarProps) {

  const {
    setTheme,
  } = useTheme();


  const [
    notificationsOpen,
    setNotificationsOpen,
  ] = useState(false);


  const [
    profileOpen,
    setProfileOpen,
  ] = useState(false);


  const unreadCount =
    useMemo(
      () =>
        notifications.filter(
          (item) =>
            !item.read,
        ).length,

      [notifications],
    );


  return (
    <header
      className={cn(
        "relative z-20 flex h-[58px] shrink-0 items-center justify-between border-b px-5 lg:px-6",

        theme === "dark"
          ? "border-white/[0.055] bg-[#050505]"
          : "border-black/10 bg-white",
      )}
    >

      {/* TITLE */}

      <div className="flex min-w-0 items-center">

        <p
          className={cn(
            "truncate text-[14px] font-medium tracking-[-0.025em]",

            theme === "dark"
              ? "text-zinc-200"
              : "text-zinc-900",
          )}
        >
          {viewLabels[activeView]}
        </p>

      </div>


      {/* ACTIONS */}

      <div className="flex items-center gap-1">

        {activeView !== "chats" &&
        activeView !== "settings" ? (
          <button
            type="button"

            onClick={() =>
              onNavigate(
                "chats"
              )
            }

            title="Close"

            className="ui-icon-button"
          >
            <X size={16} />
          </button>
        ) : null}


        {/* THEME */}

        <button
          type="button"

          onClick={() =>
            setTheme(
              theme === "dark"
                ? "light"
                : "dark",
            )
          }

          title={
            theme === "dark"
              ? "Light mode"
              : "Dark mode"
          }

          className="ui-icon-button"
        >
          {theme === "dark" ? (
            <Sun size={16} />
          ) : (
            <Moon size={16} />
          )}
        </button>


        {/* NOTIFICATIONS */}

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

              className="ui-icon-button relative"
            >

              <Bell size={16} />


              {unreadCount > 0 ? (
                <span className="absolute right-[6px] top-[6px] h-[5px] w-[5px] rounded-full bg-white" />
              ) : null}

            </button>

          </DropdownMenu.Trigger>


          <DropdownMenu.Portal>

            <DropdownMenu.Content
              sideOffset={10}

              align="end"

              className="ui-menu-surface z-50 w-[340px] p-2 text-[color:var(--foreground)]"
            >

              <div className="flex items-center justify-between gap-3 px-2.5 pb-2 pt-1.5">

                <div>

                  <p className="text-[13px] font-semibold">
                    Notifications
                  </p>

                  <p className="mt-1 text-[11px] text-zinc-500">
                    Recent workspace activity
                  </p>

                </div>


                <button
                  type="button"

                  disabled={
                    unreadCount === 0
                  }

                  onClick={
                    onMarkAllRead
                  }

                  className="flex items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[11px] text-zinc-500 hover:bg-white/[0.055] hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                >

                  <CheckCheck
                    size={13}
                  />

                  Read all

                </button>

              </div>


              <div className="mt-1 space-y-1">

                {notifications.length >
                0 ? (

                  notifications.map(
                    (item) => (

                      <div
                        key={
                          item.id
                        }

                        className="relative rounded-[11px] px-3 py-2.5 hover:bg-white/[0.045]"
                      >

                        {!item.read ? (
                          <span className="absolute left-[6px] top-[17px] h-[5px] w-[5px] rounded-full bg-white/80" />
                        ) : null}


                        <p className="pl-1 text-[12px] font-medium text-zinc-200">
                          {
                            item.title
                          }
                        </p>


                        <p className="mt-1 pl-1 text-[11px] leading-5 text-zinc-500">
                          {
                            item.detail
                          }
                        </p>

                      </div>

                    ),
                  )

                ) : (

                  <p className="px-3 py-8 text-center text-[12px] text-zinc-600">
                    Nothing new.
                  </p>

                )}

              </div>

            </DropdownMenu.Content>

          </DropdownMenu.Portal>

        </DropdownMenu.Root>


        {/* PROFILE */}

        <DropdownMenu.Root
          open={profileOpen}

          onOpenChange={
            setProfileOpen
          }
        >

          <DropdownMenu.Trigger
            asChild
          >

            <button
              type="button"

              title="Account"

              className="ml-1 flex h-9 w-9 items-center justify-center rounded-full border border-transparent hover:border-white/[0.08] hover:bg-white/[0.05]"
            >

              <UserAvatar
                size="sm"
              />

            </button>

          </DropdownMenu.Trigger>


          <DropdownMenu.Portal>

            <DropdownMenu.Content
              sideOffset={10}

              align="end"

              className="ui-menu-surface z-50 w-[245px] p-2 text-[color:var(--foreground)]"
            >

              <div className="px-2.5 pb-2 pt-1.5">

                <p className="text-[13px] font-semibold">
                  Hassan Kadri
                </p>

                <p className="mt-1 text-[11px] text-zinc-500">
                  Personal workspace
                </p>

              </div>


              <div className="my-1 border-t border-white/[0.06]" />


              <MenuItem
                icon={
                  FolderKanban
                }

                label="Workspaces"

                onSelect={() =>
                  onNavigate(
                    "projects"
                  )
                }
              />


              <MenuItem
                icon={
                  UserCircle2
                }

                label="Customize"

                onSelect={() =>
                  onNavigate(
                    "customize"
                  )
                }
              />


              <MenuItem
                icon={
                  Settings2
                }

                label="Settings"

                onSelect={() =>
                  onNavigate(
                    "settings"
                  )
                }
              />

            </DropdownMenu.Content>

          </DropdownMenu.Portal>

        </DropdownMenu.Root>

      </div>

    </header>
  );
}


function MenuItem({
  icon: Icon,

  label,

  onSelect,
}: {
  icon: React.ComponentType<{
    size?: number;
  }>;

  label: string;

  onSelect: () => void;
}) {

  return (
    <DropdownMenu.Item
      onSelect={onSelect}

      className="flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2.5 text-[12px] text-zinc-400 outline-none hover:bg-white/[0.055] hover:text-white"
    >

      <Icon size={15} />

      {label}

    </DropdownMenu.Item>
  );
}