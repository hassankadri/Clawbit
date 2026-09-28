"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "framer-motion";
import { Search, Sparkles } from "lucide-react";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useTheme } from "next-themes";
import { usePathname, useRouter } from "next/navigation";

import ChatArea from "@/components/layout/ChatArea";
import Composer from "@/components/layout/Composer";
import Sidebar from "@/components/layout/Sidebar";

import Topbar, {
  type NotificationItem,
  type ShareResult,
} from "@/components/layout/Topbar";

import Welcome from "@/components/layout/Welcome";
import WorkspacePanel from "@/components/layout/WorkspacePanel";

import SettingsWorkspace from "@/components/settings/SettingsWorkspace";

import LibraryWorkspace from "@/components/library/LibraryWorkspace";
import ProjectsWorkspace from "@/components/projects/ProjectsWorkspace";
import ProjectWorkspace from "@/components/projects/ProjectWorkspace";

import useChat, {
  type ChatSnapshot,
} from "@/hooks/useChat";

import {
  setActiveChatMode,
} from "@/lib/api";

import {
  viewFromPath,
  viewPaths,
  type RouteView,
} from "@/lib/navigation";

import {
  APP_SETTINGS_UPDATED_EVENT,
  DEFAULT_APP_SETTINGS,
  readAppSettings,
  writeAppSettings,
  type AppSettings,
} from "@/lib/settings";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  pinned: boolean;
  snapshot: ChatSnapshot;
  updatedAt: number;
}

type ProjectVisibility =
  | "created"
  | "shared";

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

  kind:
    | "document"
    | "image";

  uploadedAt: number;
}

interface ProjectRecord {
  id: string;
  name: string;
  description: string;

  visibility:
    ProjectVisibility;

  createdAt: number;
  updatedAt: number;

  conversations:
    ProjectConversation[];

  files:
    ProjectFile[];
}

interface ComposerAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  detail: string;
  preview?: string;

  kind:
    | "document"
    | "image";
}

/* ====================================================== */
/* STORAGE                                                */
/* ====================================================== */

const projectStorageKey =
  "clawbit.projects.v1";

const activeProjectStorageKey =
  "clawbit.projects.active.v1";

const conversationStorageKey =
  "clawbit.conversations.v1";

const activeConversationStorageKey =
  "clawbit.conversations.active.v1";

const personalizationStorageKey =
  "clawbit.customization.state.v1";

const notificationStorageKey =
  "clawbit.notifications.v2";

const defaultAssistantName =
  "Clawbit";

/* ====================================================== */
/* HELPERS                                                */
/* ====================================================== */

function readAssistantNameFromStorage() {
  if (
    typeof window ===
    "undefined"
  ) {
    return defaultAssistantName;
  }

  try {
    const rawValue =
      window.localStorage.getItem(
        personalizationStorageKey,
      );

    if (!rawValue) {
      return defaultAssistantName;
    }

    const parsed =
      JSON.parse(
        rawValue,
      ) as {
        assistantName?: unknown;
      };

    if (
      typeof parsed.assistantName ===
        "string" &&
      parsed.assistantName.trim()
    ) {
      return parsed.assistantName.trim();
    }
  } catch {
    // Ignore invalid local storage.
  }

  return defaultAssistantName;
}

function summarizeConversation(
  snapshot: ChatSnapshot,
) {
  const userMessage =
    snapshot.messages.find(
      (message) =>
        message.role ===
          "user" &&
        message.content
          .trim()
          .length > 0,
    );

  const assistantMessage =
    [
      ...snapshot.messages,
    ]
      .reverse()
      .find(
        (message) =>
          message.role ===
          "assistant",
      );

  const titleSource =
    userMessage?.content ??
    "New chat";

  const previewSource =
    assistantMessage?.content ??
    userMessage?.content ??
    "No messages yet";

  return {
    title:
      titleSource.slice(
        0,
        36,
      ) || "New chat",

    preview:
      previewSource.slice(
        0,
        84,
      ) || "No messages yet",
  };
}

/* ====================================================== */
/* COMMAND PALETTE                                        */
/* ====================================================== */

const commandItems: Array<{
  label: string;
  view: RouteView;
}> = [
  {
    label:
      "Return to conversation",

    view:
      "chats",
  },

  {
    label:
      "Open Projects",

    view:
      "projects",
  },

  {
    label:
      "Open Tools",

    view:
      "plugins",
  },

  {
    label:
      "Open Library",

    view:
      "library",
  },

  {
    label:
      "Open Profile",

    view:
      "profile",
  },

  {
    label:
      "Open Personalization",

    view:
      "customize",
  },

  {
    label:
      "Open Settings",

    view:
      "settings",
  },

  {
    label:
      "Open Help & Docs",

    view:
      "help",
  },
];

/* ====================================================== */
/* APP SHELL                                              */
/* ====================================================== */

export default function AppShell({
  children,
}: {
  children:
    ReactNode;
}) {
  const {
    messages,
    loading,
    sendMessage,
    model,
    setModel,
    clearChat,
    deleteMessage,
    editMessage,
    createSnapshot,
    restoreSnapshot,
    retryAssistantMessage,
    stopGeneration,
    threadId,
  } = useChat();

  const {
    resolvedTheme,

    theme:
      selectedTheme,
  } = useTheme();

  const pathname =
    usePathname();

  const router =
    useRouter();

  const routeView =
    viewFromPath(
      pathname,
    );

  const activeView =
    routeView ??
    "chats";

  function setActiveView(
    view:
      RouteView,
  ) {
    if (
      pathname !==
      viewPaths[
        view
      ]
    ) {
      router.push(
        viewPaths[
          view
        ],
        {
          scroll:
            false,
        },
      );
    }
  }

  /* ==================================================== */
  /* STATE                                                */
  /* ==================================================== */

  const [
    sidebarCollapsed,
    setSidebarCollapsed,
  ] =
    useState(
      false,
    );

  const [
    notifications,
    setNotifications,
  ] =
    useState<
      NotificationItem[]
    >(
      [],
    );

  const [
    commandOpen,
    setCommandOpen,
  ] =
    useState(
      false,
    );

  const [
    assistantName,
    setAssistantName,
  ] =
    useState(
      defaultAssistantName,
    );

  const [
    appSettings,
    setAppSettings,
  ] =
    useState<AppSettings>(
      DEFAULT_APP_SETTINGS,
    );

  const [
    activeConversationId,
    setActiveConversationId,
  ] =
    useState<string>(
      "initial-conversation",
    );

  const [
    conversationHistory,
    setConversationHistory,
  ] =
    useState<
      ConversationSummary[]
    >(
      [],
    );

  const [
    projects,
    setProjects,
  ] =
    useState<
      ProjectRecord[]
    >(
      [],
    );

  const [
    activeProjectId,
    setActiveProjectId,
  ] =
    useState<
      string | null
    >(
      null,
    );

  const [
    composerPrefill,
    setComposerPrefill,
  ] =
    useState<{
      id: number;
      text: string;
    } | null>(
      null,
    );

  /* ==================================================== */
  /* REFS                                                 */
  /* ==================================================== */

  const projectsHydratedRef =
    useRef(
      false,
    );

  const conversationsHydratedRef =
    useRef(
      false,
    );

  const notificationsHydratedRef =
    useRef(
      false,
    );

  const messagesLengthRef =
    useRef(
      messages.length,
    );

  const restoreSnapshotRef =
    useRef(
      restoreSnapshot,
    );

  const settingsRef =
    useRef<AppSettings>(
      DEFAULT_APP_SETTINGS,
    );

  useEffect(() => {
    restoreSnapshotRef.current =
      restoreSnapshot;
  }, [
    restoreSnapshot,
  ]);

  useEffect(() => {
    messagesLengthRef.current =
      messages.length;
  }, [
    messages.length,
  ]);

  useEffect(() => {
    settingsRef.current =
      appSettings;
  }, [
    appSettings,
  ]);

  /* ==================================================== */
  /* NOTIFICATIONS                                        */
  /* ==================================================== */

  const addNotification =
    useCallback(
      (
        title:
          string,

        detail:
          string,
      ) => {
        if (
          !settingsRef.current
            .notifications
        ) {
          return;
        }

        const notification:
          NotificationItem =
          {
            id:
              crypto.randomUUID(),

            title,

            detail,

            read:
              false,
          };

        setNotifications(
          (
            current,
          ) => [
            notification,
            ...current,
          ].slice(
            0,
            50,
          ),
        );
      },

      [],
    );

  /* ==================================================== */
  /* PROJECT CHAT UPSERT                                  */
  /* ==================================================== */

  const upsertProjectConversation =
    useCallback(
      (
        projectId:
          string,

        snapshot:
          ChatSnapshot,
      ) => {
        const summary =
          summarizeConversation(
            snapshot,
          );

        setProjects(
          (
            current,
          ) =>
            current.map(
              (
                project,
              ) => {
                if (
                  project.id !==
                  projectId
                ) {
                  return project;
                }

                const conversation:
                  ProjectConversation =
                  {
                    id:
                      snapshot.threadId,

                    title:
                      summary.title,

                    preview:
                      summary.preview,

                    snapshot,

                    updatedAt:
                      Date.now(),
                  };

                const conversations =
                  [
                    conversation,

                    ...project.conversations.filter(
                      (
                        item,
                      ) =>
                        item.id !==
                        conversation.id,
                    ),
                  ].sort(
                    (
                      left,
                      right,
                    ) =>
                      right.updatedAt -
                      left.updatedAt,
                  );

                return {
                  ...project,

                  updatedAt:
                    Date.now(),

                  conversations,
                };
              },
            ),
        );
      },

      [],
    );

  /* ==================================================== */
  /* PERSONALIZATION                                      */
  /* ==================================================== */

  useEffect(() => {
    function syncAssistantName() {
      setAssistantName(
        readAssistantNameFromStorage(),
      );
    }

    function handlePersonalizationUpdated(
      event:
        Event,
    ) {
      const detail =
        (
          event as CustomEvent<{
            assistantName?:
              unknown;

            defaultMode?:
              unknown;
          }>
        ).detail;

      if (
        typeof detail?.assistantName ===
          "string" &&
        detail.assistantName.trim()
      ) {
        setAssistantName(
          detail.assistantName.trim(),
        );
      } else {
        syncAssistantName();
      }

      if (
        detail?.defaultMode ===
          "normal" ||
        detail?.defaultMode ===
          "research"
      ) {
        writeAppSettings({
          defaultChatMode:
            detail.defaultMode,
        });

        setActiveChatMode(
          detail.defaultMode,
        );
      }
    }

    function handleStorage(
      event:
        StorageEvent,
    ) {
      if (
        event.key ===
        personalizationStorageKey
      ) {
        syncAssistantName();
      }
    }

    syncAssistantName();

    window.addEventListener(
      "clawbit:personalization-updated",
      handlePersonalizationUpdated,
    );

    window.addEventListener(
      "storage",
      handleStorage,
    );

    return () => {
      window.removeEventListener(
        "clawbit:personalization-updated",
        handlePersonalizationUpdated,
      );

      window.removeEventListener(
        "storage",
        handleStorage,
      );
    };
  }, []);

  /* ==================================================== */
  /* SETTINGS                                             */
  /* ==================================================== */

  useEffect(() => {
    function applySettings(
      nextSettings:
        AppSettings,
    ) {
      settingsRef.current =
        nextSettings;

      setAppSettings(
        nextSettings,
      );

      setActiveChatMode(
        nextSettings.defaultChatMode,
      );

      if (
        messagesLengthRef.current ===
        0
      ) {
        setModel(
          nextSettings.defaultModel,
        );
      }
    }

    applySettings(
      readAppSettings(),
    );

    function handleSettingsUpdated(
      event:
        Event,
    ) {
      const detail =
        (
          event as CustomEvent<AppSettings>
        ).detail;

      const nextSettings =
        detail ??
        readAppSettings();

      applySettings(
        nextSettings,
      );

      if (
        nextSettings.notifications
      ) {
        const notification:
          NotificationItem =
          {
            id:
              crypto.randomUUID(),

            title:
              "Settings updated",

            detail:
              "Your Clawbit app settings were updated.",

            read:
              false,
          };

        setNotifications(
          (
            current,
          ) => [
            notification,
            ...current,
          ].slice(
            0,
            50,
          ),
        );
      }
    }

    window.addEventListener(
      APP_SETTINGS_UPDATED_EVENT,
      handleSettingsUpdated,
    );

    return () => {
      window.removeEventListener(
        APP_SETTINGS_UPDATED_EVENT,
        handleSettingsUpdated,
      );
    };
  }, [
    setModel,
  ]);

  useEffect(() => {
    if (
      selectedTheme !==
        "system" &&
      selectedTheme !==
        "dark" &&
      selectedTheme !==
        "light"
    ) {
      return;
    }

    if (
      selectedTheme ===
      appSettings.themeMode
    ) {
      return;
    }

    writeAppSettings({
      themeMode:
        selectedTheme,
    });
  }, [
    selectedTheme,
    appSettings.themeMode,
  ]);

  /* ==================================================== */
  /* COMMAND SHORTCUT                                     */
  /* ==================================================== */

  useEffect(() => {
    function handleKeyDown(
      event:
        KeyboardEvent,
    ) {
      if (
        (
          event.ctrlKey ||
          event.metaKey
        ) &&
        event.key.toLowerCase() ===
          "k"
      ) {
        event.preventDefault();

        setCommandOpen(
          true,
        );
      }
    }

    window.addEventListener(
      "keydown",
      handleKeyDown,
    );

    return () =>
      window.removeEventListener(
        "keydown",
        handleKeyDown,
      );
  }, []);

  const theme =
    (
      resolvedTheme ??
      "dark"
    ) as Theme;

  /* ==================================================== */
  /* LOAD PROJECTS                                        */
  /* ==================================================== */

  useEffect(() => {
    try {
      const rawProjects =
        window.localStorage.getItem(
          projectStorageKey,
        );

      const rawActiveProject =
        window.localStorage.getItem(
          activeProjectStorageKey,
        );

      queueMicrotask(
        () => {
          let parsedProjects:
            ProjectRecord[] =
            [];

          if (
            rawProjects
          ) {
            const parsed =
              JSON.parse(
                rawProjects,
              ) as ProjectRecord[];

            parsedProjects =
              Array.isArray(
                parsed,
              )
                ? parsed
                : [];

            setProjects(
              parsedProjects,
            );
          }

          if (
            rawActiveProject &&
            parsedProjects.some(
              (
                project,
              ) =>
                project.id ===
                rawActiveProject,
            )
          ) {
            setActiveProjectId(
              rawActiveProject,
            );
          }

          projectsHydratedRef.current =
            true;
        },
      );
    } catch {
      queueMicrotask(
        () => {
          setProjects(
            [],
          );

          setActiveProjectId(
            null,
          );

          projectsHydratedRef.current =
            true;
        },
      );
    }
  }, []);

  /* ==================================================== */
  /* LOAD CONVERSATIONS                                   */
  /* ==================================================== */

  useEffect(() => {
    try {
      const rawConversations =
        window.localStorage.getItem(
          conversationStorageKey,
        );

      const rawActiveConversation =
        window.localStorage.getItem(
          activeConversationStorageKey,
        );

      queueMicrotask(
        () => {
          let parsedConversations:
            ConversationSummary[] =
            [];

          if (
            rawConversations
          ) {
            const parsed =
              JSON.parse(
                rawConversations,
              ) as ConversationSummary[];

            parsedConversations =
              Array.isArray(
                parsed,
              )
                ? parsed
                : [];

            setConversationHistory(
              parsedConversations,
            );
          }

          if (
            rawActiveConversation &&
            parsedConversations.some(
              (
                item,
              ) =>
                item.id ===
                rawActiveConversation,
            )
          ) {
            setActiveConversationId(
              rawActiveConversation,
            );
          }

          conversationsHydratedRef.current =
            true;
        },
      );
    } catch {
      queueMicrotask(
        () => {
          setConversationHistory(
            [],
          );

          conversationsHydratedRef.current =
            true;
        },
      );
    }
  }, []);

  /* ==================================================== */
  /* LOAD NOTIFICATIONS                                   */
  /* ==================================================== */

  useEffect(() => {
    try {
      const rawNotifications =
        window.localStorage.getItem(
          notificationStorageKey,
        );

      queueMicrotask(
        () => {
          if (
            rawNotifications
          ) {
            const parsed =
              JSON.parse(
                rawNotifications,
              ) as NotificationItem[];

            setNotifications(
              Array.isArray(
                parsed,
              )
                ? parsed
                : [],
            );
          }

          notificationsHydratedRef.current =
            true;
        },
      );
    } catch {
      queueMicrotask(
        () => {
          setNotifications(
            [],
          );

          notificationsHydratedRef.current =
            true;
        },
      );
    }
  }, []);

  /* ==================================================== */
  /* SAVE PROJECTS                                        */
  /* ==================================================== */

  useEffect(() => {
    if (
      !projectsHydratedRef.current
    ) {
      return;
    }

    try {
      window.localStorage.setItem(
        projectStorageKey,
        JSON.stringify(
          projects,
        ),
      );
    } catch {
      // Storage unavailable.
    }
  }, [
    projects,
  ]);

  useEffect(() => {
    if (
      !projectsHydratedRef.current
    ) {
      return;
    }

    try {
      if (
        activeProjectId
      ) {
        window.localStorage.setItem(
          activeProjectStorageKey,
          activeProjectId,
        );
      } else {
        window.localStorage.removeItem(
          activeProjectStorageKey,
        );
      }
    } catch {
      // Storage unavailable.
    }
  }, [
    activeProjectId,
  ]);

  /* ==================================================== */
  /* SAVE CONVERSATIONS                                   */
  /* ==================================================== */

  useEffect(() => {
    if (
      !conversationsHydratedRef.current
    ) {
      return;
    }

    try {
      window.localStorage.setItem(
        conversationStorageKey,
        JSON.stringify(
          conversationHistory,
        ),
      );
    } catch {
      // Storage unavailable.
    }
  }, [
    conversationHistory,
  ]);

  useEffect(() => {
    if (
      !conversationsHydratedRef.current
    ) {
      return;
    }

    try {
      window.localStorage.setItem(
        activeConversationStorageKey,
        activeConversationId,
      );
    } catch {
      // Storage unavailable.
    }
  }, [
    activeConversationId,
  ]);

  /* ==================================================== */
  /* SAVE NOTIFICATIONS                                   */
  /* ==================================================== */

  useEffect(() => {
    if (
      !notificationsHydratedRef.current
    ) {
      return;
    }

    try {
      window.localStorage.setItem(
        notificationStorageKey,
        JSON.stringify(
          notifications,
        ),
      );
    } catch {
      // Storage unavailable.
    }
  }, [
    notifications,
  ]);

  /* ==================================================== */
  /* RESTORE ACTIVE CHAT                                  */
  /* ==================================================== */

  useEffect(() => {
    if (
      !conversationsHydratedRef.current
    ) {
      return;
    }

    if (
      activeProjectId ||
      messages.length >
        0
    ) {
      return;
    }

    const activeConversation =
      conversationHistory.find(
        (
          item,
        ) =>
          item.id ===
          activeConversationId,
      );

    if (
      activeConversation
    ) {
      restoreSnapshotRef.current(
        activeConversation.snapshot,
      );
    }
  }, [
    activeConversationId,
    activeProjectId,
    conversationHistory,
    messages.length,
  ]);

  /* ==================================================== */
  /* AUTO SAVE                                            */
  /* ==================================================== */

  useEffect(() => {
    if (
      messages.length ===
      0
    ) {
      return;
    }

    const snapshot:
      ChatSnapshot =
      {
        messages,
        threadId,
        model,
      };

    const summary =
      summarizeConversation(
        snapshot,
      );

    const syncHandle =
      window.setTimeout(
        () => {
          if (
            activeProjectId
          ) {
            upsertProjectConversation(
              activeProjectId,
              snapshot,
            );

            return;
          }

          setConversationHistory(
            (
              current,
            ) => {
              const existing =
                current.find(
                  (
                    item,
                  ) =>
                    item.id ===
                    activeConversationId,
                );

              const previewItem:
                ConversationSummary =
                {
                  id:
                    activeConversationId,

                  title:
                    existing?.title ??
                    summary.title,

                  preview:
                    summary.preview,

                  pinned:
                    existing?.pinned ??
                    false,

                  snapshot,

                  updatedAt:
                    Date.now(),
                };

              const withoutCurrent =
                current.filter(
                  (
                    item,
                  ) =>
                    item.id !==
                    activeConversationId,
                );

              return [
                previewItem,
                ...withoutCurrent,
              ]
                .sort(
                  (
                    left,
                    right,
                  ) => {
                    if (
                      left.pinned !==
                      right.pinned
                    ) {
                      return left.pinned
                        ? -1
                        : 1;
                    }

                    return (
                      right.updatedAt -
                      left.updatedAt
                    );
                  },
                )
                .slice(
                  0,
                  12,
                );
            },
          );
        },

        0,
      );

    return () =>
      window.clearTimeout(
        syncHandle,
      );
  }, [
    activeConversationId,
    activeProjectId,
    messages,
    model,
    threadId,
    upsertProjectConversation,
  ]);

  /* ==================================================== */
  /* DERIVED                                              */
  /* ==================================================== */

  const shellClass =
    "bg-[color:var(--background)] text-[color:var(--foreground)]";

  const activeProject =
    useMemo(
      () =>
        activeProjectId
          ? projects.find(
              (
                project,
              ) =>
                project.id ===
                activeProjectId,
            ) ??
            null
          : null,

      [
        projects,
        activeProjectId,
      ],
    );

  const activeGlobalConversation =
    useMemo(
      () =>
        conversationHistory.find(
          (
            item,
          ) =>
            item.id ===
            activeConversationId,
        ) ??
        null,

      [
        conversationHistory,
        activeConversationId,
      ],
    );

  const showProjectWorkspace =
    activeView ===
      "chats" &&
    activeProject !==
      null &&
    messages.length ===
      0;

  /*
   * Fresh normal chat:
   *
   * Instead of rendering Composer at the bottom,
   * Welcome will render the SAME Composer in the center.
   */

  const showCenteredHomeComposer =
    activeView ===
      "chats" &&
    activeProjectId ===
      null &&
    messages.length ===
      0;

  useEffect(() => {
    if (
      !projectsHydratedRef.current ||
      activeView !==
        "chats" ||
      !activeProjectId ||
      messages.length >
        0
    ) {
      return;
    }

    const project =
      projects.find(
        (
          item,
        ) =>
          item.id ===
          activeProjectId,
      );

    const latestConversation =
      project?.conversations[
        0
      ];

    if (
      !latestConversation
    ) {
      return;
    }

    restoreSnapshotRef.current(
      latestConversation.snapshot,
    );
  }, [
    activeProjectId,
    activeView,
    messages.length,
    projects,
  ]);

  /* ==================================================== */
  /* CHAT HELPERS                                         */
  /* ==================================================== */

  function resetFreshChatDefaults() {
    setModel(
      appSettings.defaultModel,
    );

    setActiveChatMode(
      appSettings.defaultChatMode,
    );
  }

  function saveCurrentConversation() {
    if (
      messages.length ===
      0
    ) {
      return;
    }

    const snapshot =
      createSnapshot();

    if (
      activeProjectId
    ) {
      upsertProjectConversation(
        activeProjectId,
        snapshot,
      );

      return;
    }

    const summary =
      summarizeConversation(
        snapshot,
      );

    setConversationHistory(
      (
        current,
      ) => {
        const existing =
          current.find(
            (
              item,
            ) =>
              item.id ===
              activeConversationId,
          );

        const conversation:
          ConversationSummary =
          {
            id:
              activeConversationId,

            title:
              existing?.title ??
              summary.title,

            preview:
              summary.preview,

            pinned:
              existing?.pinned ??
              false,

            snapshot,

            updatedAt:
              Date.now(),
          };

        return [
          conversation,

          ...current.filter(
            (
              item,
            ) =>
              item.id !==
              activeConversationId,
          ),
        ].slice(
          0,
          12,
        );
      },
    );
  }

  /* ==================================================== */
  /* NOTIFICATION ACTIONS                                 */
  /* ==================================================== */

  function markAllNotificationsRead() {
    setNotifications(
      (
        current,
      ) =>
        current.map(
          (
            item,
          ) => ({
            ...item,

            read:
              true,
          }),
        ),
    );
  }

  function markNotificationRead(
    id:
      string,
  ) {
    setNotifications(
      (
        current,
      ) =>
        current.map(
          (
            item,
          ) =>
            item.id ===
            id
              ? {
                  ...item,

                  read:
                    true,
                }
              : item,
        ),
    );
  }

  function dismissNotification(
    id:
      string,
  ) {
    setNotifications(
      (
        current,
      ) =>
        current.filter(
          (
            item,
          ) =>
            item.id !==
            id,
        ),
    );
  }

  /* ==================================================== */
  /* CHAT                                                 */
  /* ==================================================== */

  function handleSuggestion(
    prompt:
      string,
  ) {
    setActiveProjectId(
      null,
    );

    setActiveView(
      "chats",
    );

    setComposerPrefill({
      id:
        Date.now(),

      text:
        prompt,
    });
  }

  async function handleSend(
    message:
      string,

    attachmentIds:
      string[] = [],
  ) {
    setActiveView(
      "chats",
    );

    /*
     * Clear suggestion/prefill immediately.
     *
     * Otherwise the bottom Composer mounts after the first
     * message and receives the old suggestion again.
     */

    setComposerPrefill(
      null,
    );

    await sendMessage(
      message,
      attachmentIds,
    );
  }

  function startNewChat() {
    saveCurrentConversation();

    setActiveProjectId(
      null,
    );

    clearChat();

    resetFreshChatDefaults();

    /*
     * New UUID = Welcome receives a different conversationKey,
     * which gives the new chat another greeting/suggestion set.
     */

    setActiveConversationId(
      crypto.randomUUID(),
    );

    setComposerPrefill(
      null,
    );

    setActiveView(
      "chats",
    );
  }

  function openConversation(
    id:
      string,
  ) {
    const conversation =
      conversationHistory.find(
        (
          item,
        ) =>
          item.id ===
          id,
      );

    if (
      !conversation
    ) {
      return;
    }

    saveCurrentConversation();

    setActiveProjectId(
      null,
    );

    restoreSnapshot(
      conversation.snapshot,
    );

    setActiveConversationId(
      conversation.id,
    );

    setComposerPrefill(
      null,
    );

    setActiveView(
      "chats",
    );
  }

  /* ==================================================== */
  /* PIN                                                  */
  /* ==================================================== */

  function toggleConversationPin(
    id:
      string,
  ) {
    setConversationHistory(
      (
        current,
      ) =>
        current.map(
          (
            item,
          ) =>
            item.id ===
            id
              ? {
                  ...item,

                  pinned:
                    !item.pinned,

                  updatedAt:
                    Date.now(),
                }
              : item,
        ),
    );
  }

  function toggleActiveChatPin() {
    if (
      activeProjectId ||
      messages.length ===
        0
    ) {
      return;
    }

    const snapshot:
      ChatSnapshot =
      {
        messages,
        threadId,
        model,
      };

    const summary =
      summarizeConversation(
        snapshot,
      );

    setConversationHistory(
      (
        current,
      ) => {
        const existing =
          current.find(
            (
              item,
            ) =>
              item.id ===
              activeConversationId,
          );

        if (
          existing
        ) {
          return current.map(
            (
              item,
            ) =>
              item.id ===
              activeConversationId
                ? {
                    ...item,

                    pinned:
                      !item.pinned,

                    updatedAt:
                      Date.now(),
                  }
                : item,
          );
        }

        return [
          {
            id:
              activeConversationId,

            title:
              summary.title,

            preview:
              summary.preview,

            pinned:
              true,

            snapshot,

            updatedAt:
              Date.now(),
          },

          ...current,
        ];
      },
    );
  }

  function renameConversation(
    id:
      string,

    title:
      string,
  ) {
    const trimmed =
      title.trim();

    if (
      !trimmed
    ) {
      return;
    }

    setConversationHistory(
      (
        current,
      ) =>
        current.map(
          (
            item,
          ) =>
            item.id ===
            id
              ? {
                  ...item,

                  title:
                    trimmed,

                  updatedAt:
                    Date.now(),
                }
              : item,
        ),
    );
  }

  function deleteConversation(
    id:
      string,
  ) {
    if (
      appSettings.confirmDestructiveActions &&
      !window.confirm(
        "Delete this chat?\n\nThe locally saved conversation will be removed from this browser.",
      )
    ) {
      return;
    }

    setConversationHistory(
      (
        current,
      ) =>
        current.filter(
          (
            item,
          ) =>
            item.id !==
            id,
        ),
    );

    if (
      activeConversationId ===
      id
    ) {
      clearChat();

      resetFreshChatDefaults();

      setActiveConversationId(
        crypto.randomUUID(),
      );

      setActiveView(
        "chats",
      );
    }
  }

  /* ==================================================== */
  /* SHARE                                                */
  /* ==================================================== */

  async function shareActiveChat():
    Promise<ShareResult> {
    if (
      messages.length ===
      0
    ) {
      return "empty";
    }

    const snapshot:
      ChatSnapshot =
      {
        messages,
        threadId,
        model,
      };

    const title =
      summarizeConversation(
        snapshot,
      ).title;

    const transcript =
      messages
        .map(
          (
            message,
          ) => {
            const speaker =
              message.role ===
              "user"
                ? "You"
                : assistantName;

            return `${speaker}:\n${message.content.trim()}`;
          },
        )
        .join(
          "\n\n",
        );

    const shareText =
      `${title}\n\n${transcript}`;

    if (
      typeof navigator.share ===
      "function"
    ) {
      try {
        await navigator.share({
          title,

          text:
            shareText,
        });

        return "shared";
      } catch (
        error
      ) {
        if (
          error instanceof
            DOMException &&
          error.name ===
            "AbortError"
        ) {
          return "cancelled";
        }
      }
    }

    await navigator.clipboard.writeText(
      shareText,
    );

    return "copied";
  }

  /* ==================================================== */
  /* MOVE CHAT                                            */
  /* ==================================================== */

  function moveActiveChatToProject(
    projectId:
      string,
  ) {
    if (
      activeProjectId ||
      messages.length ===
        0
    ) {
      return;
    }

    const project =
      projects.find(
        (
          item,
        ) =>
          item.id ===
          projectId,
      );

    if (
      !project
    ) {
      return;
    }

    const snapshot:
      ChatSnapshot =
      {
        messages,
        threadId,
        model,
      };

    upsertProjectConversation(
      projectId,
      snapshot,
    );

    setConversationHistory(
      (
        current,
      ) =>
        current.filter(
          (
            item,
          ) =>
            item.id !==
            activeConversationId,
        ),
    );

    setActiveProjectId(
      projectId,
    );

    setActiveConversationId(
      crypto.randomUUID(),
    );

    addNotification(
      "Chat moved to project",

      `The current chat was moved to "${project.name}".`,
    );

    setActiveView(
      "chats",
    );
  }

  /* ==================================================== */
  /* DELETE ACTIVE CHAT                                   */
  /* ==================================================== */

  function deleteActiveChat() {
    if (
      messages.length ===
      0
    ) {
      return;
    }

    if (
      !activeProjectId
    ) {
      deleteConversation(
        activeConversationId,
      );

      return;
    }

    if (
      appSettings.confirmDestructiveActions &&
      !window.confirm(
        "Delete this project chat?\n\nThis removes the conversation from the current project.",
      )
    ) {
      return;
    }

    setProjects(
      (
        current,
      ) =>
        current.map(
          (
            project,
          ) =>
            project.id ===
            activeProjectId
              ? {
                  ...project,

                  updatedAt:
                    Date.now(),

                  conversations:
                    project.conversations.filter(
                      (
                        conversation,
                      ) =>
                        conversation.id !==
                        threadId,
                    ),
                }
              : project,
        ),
    );

    clearChat();

    resetFreshChatDefaults();
  }

  /* ==================================================== */
  /* PROJECT FILES                                        */
  /* ==================================================== */

  function addProjectFiles(
    projectId:
      string,

    files:
      ComposerAttachment[],
  ) {
    if (
      files.length ===
      0
    ) {
      return;
    }

    setProjects(
      (
        current,
      ) =>
        current.map(
          (
            project,
          ) => {
            if (
              project.id !==
              projectId
            ) {
              return project;
            }

            const fileMap =
              new Map(
                project.files.map(
                  (
                    item,
                  ) => [
                    item.id,
                    item,
                  ] as const,
                ),
              );

            for (
              const file of
              files
            ) {
              fileMap.set(
                file.id,

                {
                  ...file,

                  uploadedAt:
                    Date.now(),
                },
              );
            }

            return {
              ...project,

              updatedAt:
                Date.now(),

              files:
                [
                  ...fileMap.values(),
                ].sort(
                  (
                    left,
                    right,
                  ) =>
                    right.uploadedAt -
                    left.uploadedAt,
                ),
            };
          },
        ),
    );
  }

  function handleAttachmentsCommitted(
    attachments:
      ComposerAttachment[],
  ) {
    if (
      attachments.length >
      0
    ) {
      addNotification(
        attachments.length ===
          1
          ? "File added to chat"
          : `${attachments.length} files added to chat`,

        attachments.length ===
          1
          ? attachments[
              0
            ].name
          : `${attachments.length} files are ready for this conversation.`,
      );
    }

    if (
      activeProjectId &&
      attachments.length >
        0
    ) {
      addProjectFiles(
        activeProjectId,
        attachments,
      );
    }
  }

  /* ==================================================== */
  /* PROJECTS                                             */
  /* ==================================================== */

  function createProject(
    name:
      string,

    description:
      string,
  ) {
    const trimmedName =
      name.trim();

    const trimmedDescription =
      description.trim();

    if (
      !trimmedName ||
      !trimmedDescription
    ) {
      return "";
    }

    const projectId =
      crypto.randomUUID();

    const nextProject:
      ProjectRecord =
      {
        id:
          projectId,

        name:
          trimmedName,

        description:
          trimmedDescription,

        visibility:
          "created",

        createdAt:
          Date.now(),

        updatedAt:
          Date.now(),

        conversations:
          [],

        files:
          [],
      };

    setProjects(
      (
        current,
      ) => [
        nextProject,

        ...current,
      ],
    );

    addNotification(
      "Project created",

      `"${trimmedName}" is ready to use.`,
    );

    return projectId;
  }

  function renameProject(
    projectId:
      string,

    name:
      string,
  ) {
    const trimmed =
      name.trim();

    if (
      !trimmed
    ) {
      return;
    }

    setProjects(
      (
        current,
      ) =>
        current.map(
          (
            project,
          ) =>
            project.id ===
            projectId
              ? {
                  ...project,

                  name:
                    trimmed,

                  updatedAt:
                    Date.now(),
                }
              : project,
        ),
    );
  }

  function deleteProject(
    projectId:
      string,

    skipConfirmation =
      false,
  ) {
    const project =
      projects.find(
        (
          item,
        ) =>
          item.id ===
          projectId,
      );

    if (
      !skipConfirmation &&
      appSettings.confirmDestructiveActions &&
      !window.confirm(
        `Delete "${project?.name ?? "this project"}"?`,
      )
    ) {
      return;
    }

    setProjects(
      (
        current,
      ) =>
        current.filter(
          (
            item,
          ) =>
            item.id !==
            projectId,
        ),
    );

    if (
      activeProjectId ===
      projectId
    ) {
      setActiveProjectId(
        null,
      );

      clearChat();

      resetFreshChatDefaults();

      setActiveView(
        "projects",
      );
    }
  }

  function openProject(
    projectId:
      string,
  ) {
    const project =
      projects.find(
        (
          item,
        ) =>
          item.id ===
          projectId,
      );

    if (
      !project
    ) {
      return;
    }

    saveCurrentConversation();

    setActiveProjectId(
      projectId,
    );

    const latestConversation =
      project.conversations[
        0
      ];

    if (
      latestConversation
    ) {
      restoreSnapshot(
        latestConversation.snapshot,
      );
    } else {
      clearChat();

      resetFreshChatDefaults();
    }

    setComposerPrefill(
      null,
    );

    setActiveView(
      "chats",
    );
  }

  async function startProjectChat(
    prompt:
      string,

    attachmentIds:
      string[] = [],
  ) {
    if (
      !activeProjectId ||
      loading
    ) {
      return;
    }

    await sendMessage(
      prompt,
      attachmentIds,
    );
  }

  function openProjectConversation(
    conversation:
      ProjectConversation,
  ) {
    if (
      !activeProjectId
    ) {
      return;
    }

    saveCurrentConversation();

    restoreSnapshot(
      conversation.snapshot,
    );

    setComposerPrefill(
      null,
    );

    setActiveView(
      "chats",
    );
  }

  function deleteActiveProject() {
    if (
      !activeProject
    ) {
      return;
    }

    deleteProject(
      activeProject.id,
    );
  }

  /* ==================================================== */
  /* CHAT HISTORY                                         */
  /* ==================================================== */

  const sortedConversations =
    useMemo(
      () =>
        [
          ...conversationHistory,
        ].sort(
          (
            left,
            right,
          ) => {
            if (
              left.pinned !==
              right.pinned
            ) {
              return left.pinned
                ? -1
                : 1;
            }

            return (
              right.updatedAt -
              left.updatedAt
            );
          },
        ),

      [
        conversationHistory,
      ],
    );

  const pinnedChats =
    sortedConversations.filter(
      (
        item,
      ) =>
        item.pinned,
    );

  const recentChats =
    sortedConversations.filter(
      (
        item,
      ) =>
        !item.pinned,
    );

  const hasActiveChat =
    activeView ===
      "chats" &&
    messages.length >
      0;

  /* ==================================================== */
  /* SHARED COMPOSER                                      */
  /* ==================================================== */

  /*
   * IMPORTANT:
   *
   * This is ONE real Composer configuration.
   *
   * On an empty global chat it renders inside Welcome.
   * After the first message it renders at the bottom.
   */

  const composerElement =
    (
      <Composer
        assistantName={
          assistantName
        }

        key={
          activeProjectId
            ? `${activeProjectId}-${threadId}-${appSettings.defaultChatMode}`
            : `${activeConversationId}-${appSettings.defaultChatMode}`
        }

        theme={
          theme
        }

        loading={
          loading
        }

        prefill={
          composerPrefill
        }

        onSend={
          handleSend
        }

        model={
          model
        }

        threadId={
          threadId
        }

        onModelChange={
          setModel
        }

        onAttachmentsCommitted={
          handleAttachmentsCommitted
        }
      />
    );

  /* ==================================================== */
  /* UI                                                   */
  /* ==================================================== */

  return (
    <main
      className={cn(
        "relative flex h-screen overflow-hidden",
        shellClass,
      )}
    >
      <Sidebar
        theme={
          theme
        }

        activeView={
          activeView
        }

        collapsed={
          sidebarCollapsed
        }

        pinnedChats={
          pinnedChats
        }

        recentChats={
          recentChats
        }

        projects={
          projects
        }

        activeProjectId={
          activeProjectId
        }

        onOpenProject={
          openProject
        }

        activeConversationId={
          activeConversationId
        }

        onNewChat={
          startNewChat
        }

        onNavigate={
          setActiveView
        }

        onToggleCollapsed={() =>
          setSidebarCollapsed(
            (
              current,
            ) =>
              !current,
          )
        }

        onOpenCommandPalette={() =>
          setCommandOpen(
            true,
          )
        }

        onOpenConversation={
          openConversation
        }

        onTogglePinConversation={
          toggleConversationPin
        }

        onDeleteConversation={
          deleteConversation
        }

        onRenameConversation={
          renameConversation
        }
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <Topbar
          theme={
            theme
          }

          activeView={
            activeView
          }

          notifications={
            notifications
          }

          notificationsEnabled={
            appSettings.notifications
          }

          hasActiveChat={
            hasActiveChat
          }

          activeChatPinned={
            activeGlobalConversation?.pinned ??
            false
          }

          chatInProject={
            Boolean(
              activeProjectId,
            )
          }

          projects={projects.map(
            (
              project,
            ) => ({
              id:
                project.id,

              name:
                project.name,
            }),
          )}

          onMarkAllRead={
            markAllNotificationsRead
          }

          onMarkNotificationRead={
            markNotificationRead
          }

          onDismissNotification={
            dismissNotification
          }

          onNavigate={
            setActiveView
          }

          onShareChat={
            shareActiveChat
          }

          onTogglePinChat={
            toggleActiveChatPin
          }

          onMoveChatToProject={
            moveActiveChatToProject
          }

          onViewFiles={() =>
            setActiveView(
              "library",
            )
          }

          onDeleteChat={
            deleteActiveChat
          }
        />

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {!routeView ? (
            children
          ) : activeView ===
            "chats" ? (
            showProjectWorkspace &&
            activeProject ? (
              <ProjectWorkspace
                theme={
                  theme
                }

                project={
                  activeProject
                }

                projects={projects.map(
                  (
                    project,
                  ) => ({
                    id:
                      project.id,

                    name:
                      project.name,
                  }),
                )}

                loading={
                  loading
                }

                model={
                  model
                }

                threadId={
                  threadId
                }

                onModelChange={
                  setModel
                }

                onStartChat={
                  startProjectChat
                }

                onOpenConversation={
                  openProjectConversation
                }

                onChooseProject={
                  openProject
                }

                onOpenTools={() =>
                  setActiveView(
                    "plugins",
                  )
                }

                onFilesUploaded={(
                  files,
                ) => {
                  addProjectFiles(
                    activeProject.id,
                    files,
                  );

                  if (
                    files.length >
                    0
                  ) {
                    addNotification(
                      files.length ===
                        1
                        ? "File uploaded"
                        : `${files.length} files uploaded`,

                      files.length ===
                        1
                        ? `${files[0].name} was added to "${activeProject.name}".`
                        : `Files were added to "${activeProject.name}".`,
                    );
                  }
                }}

                onRenameProject={(
                  name,
                ) =>
                  renameProject(
                    activeProject.id,
                    name,
                  )
                }

                onDeleteProject={
                  deleteActiveProject
                }
              />
            ) : messages.length ===
              0 ? (
              <Welcome
                theme={
                  theme
                }

                conversationKey={
                  activeConversationId
                }

                composer={
                  composerElement
                }

                onSuggestionSelect={
                  handleSuggestion
                }
              />
            ) : (
              <ChatArea
                theme={
                  theme
                }

                assistantName={
                  assistantName
                }

                messages={
                  messages
                }

                loading={
                  loading
                }

                onEditMessage={
                  editMessage
                }

                onDeleteMessage={
                  deleteMessage
                }

                onRetryMessage={
                  retryAssistantMessage
                }

                onStopGeneration={
                  stopGeneration
                }
              />
            )
          ) : activeView ===
            "projects" ? (
            <ProjectsWorkspace
              theme={
                theme
              }

              projects={
                projects
              }

              activeProjectId={
                activeProjectId
              }

              onCreateProject={
                createProject
              }

              onRenameProject={
                renameProject
              }

              onDeleteProject={
                deleteProject
              }

              onOpenProject={
                openProject
              }
            />
          ) : activeView ===
            "library" ? (
            <LibraryWorkspace
              theme={
                theme
              }
            />
          ) : activeView ===
            "settings" ? (
            <SettingsWorkspace
              onExitSettings={() =>
                setActiveView(
                  "chats",
                )
              }
            />
          ) : (
            <WorkspacePanel
              view={
                activeView
              }

              theme={
                theme
              }

              projects={
                projects
              }

              activeProjectId={
                activeProjectId
              }

              onExitSettings={() =>
                setActiveView(
                  "chats",
                )
              }

              onCreateProject={(
                name,
              ) =>
                createProject(
                  name,
                  "Project workspace",
                )
              }

              onRenameProject={
                renameProject
              }

              onDeleteProject={
                deleteProject
              }

              onOpenProject={
                openProject
              }
            />
          )}
        </div>

        {/* ============================================= */}
        {/* NORMAL BOTTOM COMPOSER                        */}
        {/* ============================================= */}

        {activeView !==
          "library" &&
        activeView !==
          "projects" &&
        !showProjectWorkspace &&
        !showCenteredHomeComposer ? (
          composerElement
        ) : null}
      </div>

      {/* ================================================= */}
      {/* COMMAND PALETTE                                   */}
      {/* ================================================= */}

      <Dialog.Root
        open={
          commandOpen
        }

        onOpenChange={
          setCommandOpen
        }
      >
        <AnimatePresence>
          {commandOpen ? (
            <Dialog.Portal
              forceMount
            >
              <Dialog.Overlay
                asChild
              >
                <motion.div
                  className="fixed inset-0 z-40 bg-black/45 backdrop-blur-md"

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
                />
              </Dialog.Overlay>

              <Dialog.Content
                asChild
              >
                <motion.div
                  initial={{
                    opacity:
                      0,

                    scale:
                      0.97,

                    y:
                      10,
                  }}

                  animate={{
                    opacity:
                      1,

                    scale:
                      1,

                    y:
                      0,
                  }}

                  exit={{
                    opacity:
                      0,

                    scale:
                      0.97,

                    y:
                      10,
                  }}

                  className="ui-menu-surface fixed left-1/2 top-[18%] z-50 w-[min(92vw,640px)] -translate-x-1/2 p-3 text-[color:var(--foreground)]"
                >
                  <Command
                    label="Command palette"
                  >
                    <div className="flex items-center gap-3 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-3.5">
                      <Search
                        size={
                          18
                        }

                        className="text-[color:var(--muted-foreground)]"
                      />

                      <Dialog.Title className="sr-only">
                        Search navigation
                      </Dialog.Title>

                      <Command.Input
                        autoFocus

                        placeholder="Search navigation commands..."

                        className="w-full bg-transparent text-[14px] text-[color:var(--foreground)] outline-none placeholder:text-[color:var(--muted-foreground)]"
                      />
                    </div>

                    <Command.List className="mt-3 max-h-[320px] overflow-y-auto">
                      <Command.Empty className="px-3 py-8 text-center text-[13px] text-[color:var(--muted-foreground)]">
                        Nothing matched your search.
                      </Command.Empty>

                      <Command.Group heading="Go to">
                        {commandItems.map(
                          (
                            item,
                          ) => (
                            <Command.Item
                              key={
                                item.label
                              }

                              value={
                                item.label
                              }

                              onSelect={() => {
                                setActiveView(
                                  item.view,
                                );

                                setCommandOpen(
                                  false,
                                );
                              }}

                              className="flex cursor-pointer items-center gap-3 rounded-[12px] px-3 py-2.5 text-[13px] text-[color:var(--foreground)] outline-none hover:bg-[color:var(--accent-hover)] data-[selected=true]:bg-[color:var(--accent-hover)]"
                            >
                              <Sparkles
                                size={
                                  16
                                }

                                className="text-[color:var(--muted-foreground)]"
                              />

                              {
                                item.label
                              }
                            </Command.Item>
                          ),
                        )}
                      </Command.Group>
                    </Command.List>
                  </Command>
                </motion.div>
              </Dialog.Content>
            </Dialog.Portal>
          ) : null}
        </AnimatePresence>
      </Dialog.Root>
    </main>
  );
}
