"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "framer-motion";
import { Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";

import ChatArea from "@/components/layout/ChatArea";
import Composer from "@/components/layout/Composer";
import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";
import Welcome from "@/components/layout/Welcome";
import WorkspacePanel from "@/components/layout/WorkspacePanel";
import useChat from "@/hooks/useChat";
import type { ChatSnapshot } from "@/hooks/useChat";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type AppView =
  | "chats"
  | "projects"
  | "plugins"
  | "customize"
  | "settings"
  | "help";

interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  pinned: boolean;
  snapshot: ChatSnapshot;
  updatedAt: number;
}

type ProjectVisibility = "created" | "shared";

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
  kind: "document" | "image";
  uploadedAt: number;
}

interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  visibility: ProjectVisibility;
  createdAt: number;
  updatedAt: number;
  conversations: ProjectConversation[];
  files: ProjectFile[];
}

const projectStorageKey = "clawbit.projects.v1";
const activeProjectStorageKey = "clawbit.projects.active.v1";

function summarizeConversation(snapshot: ChatSnapshot) {
  const userMessage = snapshot.messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );
  const assistantMessage = [...snapshot.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  const titleSource = userMessage?.content ?? "New chat";
  const previewSource =
    assistantMessage?.content ??
    userMessage?.content ??
    "No messages yet";

  return {
    title: titleSource.slice(0, 36) || "New chat",
    preview: previewSource.slice(0, 84) || "No messages yet",
  };
}

const notificationSeed = [
  {
    id: "1",
    title: "New workspace shell deployed",
    detail: "The home experience has been refreshed with custom controls.",
    read: false,
  },
  {
    id: "2",
    title: "Gemini 3.5 Flash is active",
    detail: "The default model has been updated from deprecated options.",
    read: false,
  },
  {
    id: "3",
    title: "Settings surface is ready",
    detail: "You can navigate to the complete settings shell from the sidebar.",
    read: true,
  },
];

const commandItems: Array<{
  label: string;
  view: AppView;
}> = [
  { label: "Open Chats", view: "chats" },
  { label: "Open Projects", view: "projects" },
  { label: "Open Plugins", view: "plugins" },
  { label: "Open Customize", view: "customize" },
  { label: "Open Settings", view: "settings" },
  { label: "Open Help & Docs", view: "help" },
];

export default function Home() {
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

  const { resolvedTheme } = useTheme();

  const [activeView, setActiveView] = useState<AppView>("chats");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [notifications, setNotifications] =
    useState(notificationSeed);
  const [commandOpen, setCommandOpen] = useState(false);
  const [utilityMessage, setUtilityMessage] =
    useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] =
    useState(() => crypto.randomUUID());
  const [conversationHistory, setConversationHistory] = useState<
    ConversationSummary[]
  >([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [composerPrefill, setComposerPrefill] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const projectsHydratedRef = useRef(false);

  const upsertProjectConversation = useCallback((
    projectId: string,
    snapshot: ChatSnapshot,
  ) => {
    const summary = summarizeConversation(snapshot);

    setProjects((current) =>
      current.map((project) => {
        if (project.id !== projectId) {
          return project;
        }

        const conversation: ProjectConversation = {
          id: snapshot.threadId,
          title: summary.title,
          preview: summary.preview,
          snapshot,
          updatedAt: Date.now(),
        };

        const conversations = [
          conversation,
          ...project.conversations.filter(
            (item) => item.id !== conversation.id,
          ),
        ].sort((left, right) => right.updatedAt - left.updatedAt);

        return {
          ...project,
          updatedAt: Date.now(),
          conversations,
        };
      }),
    );
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setCommandOpen(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () =>
      window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const theme = (resolvedTheme ?? "dark") as Theme;

  useEffect(() => {
    try {
      const rawProjects = window.localStorage.getItem(projectStorageKey);
      const rawActiveProject = window.localStorage.getItem(
        activeProjectStorageKey,
      );

      queueMicrotask(() => {
        if (rawProjects) {
          const parsedProjects = JSON.parse(rawProjects) as ProjectRecord[];
          setProjects(Array.isArray(parsedProjects) ? parsedProjects : []);
        }

        if (rawActiveProject) {
          setActiveProjectId(rawActiveProject);
        }
      });
    } catch {
      queueMicrotask(() => {
        setProjects([]);
        setActiveProjectId(null);
      });
    } finally {
      projectsHydratedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!projectsHydratedRef.current) return;

    window.localStorage.setItem(projectStorageKey, JSON.stringify(projects));
  }, [projects]);

  useEffect(() => {
    if (!projectsHydratedRef.current) return;

    if (activeProjectId) {
      window.localStorage.setItem(activeProjectStorageKey, activeProjectId);
    } else {
      window.localStorage.removeItem(activeProjectStorageKey);
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (!projectsHydratedRef.current || !activeProjectId) return;

    const activeProject = projects.find((project) => project.id === activeProjectId);

    if (!activeProject) {
      queueMicrotask(() => setActiveProjectId(null));
      return;
    }

    if (messages.length === 0) {
      const latestConversation = activeProject.conversations[0];

      if (latestConversation) {
        restoreSnapshot(latestConversation.snapshot);
      }
    }
  }, [activeProjectId, projects, messages.length, restoreSnapshot]);

  useEffect(() => {
    if (messages.length === 0) return;

    const snapshot = createSnapshot();
    const summary = summarizeConversation(snapshot);
    const syncHandle = window.setTimeout(() => {
      if (activeProjectId) {
        upsertProjectConversation(activeProjectId, snapshot);
        return;
      }

      setConversationHistory((current) => {
        const existing = current.find(
          (item) => item.id === activeConversationId,
        );
        const previewItem: ConversationSummary = {
          id: activeConversationId,
          title: summary.title,
          preview: summary.preview,
          pinned: existing?.pinned ?? false,
          snapshot,
          updatedAt: Date.now(),
        };

        if (
          existing &&
          existing.title === previewItem.title &&
          existing.preview === previewItem.preview &&
          existing.pinned === previewItem.pinned &&
          existing.snapshot.threadId === previewItem.snapshot.threadId &&
          existing.snapshot.model === previewItem.snapshot.model &&
          existing.snapshot.messages.length ===
            previewItem.snapshot.messages.length
        ) {
          return current;
        }

        const withoutCurrent = current.filter(
          (item) => item.id !== activeConversationId,
        );

        return [previewItem, ...withoutCurrent]
          .sort((left, right) => {
            if (left.pinned !== right.pinned) {
              return left.pinned ? -1 : 1;
            }

            return right.updatedAt - left.updatedAt;
          })
          .slice(0, 12);
      });
    }, 0);

    return () => window.clearTimeout(syncHandle);
  }, [activeConversationId, activeProjectId, createSnapshot, messages, threadId, model, upsertProjectConversation]);

  const shellClass = useMemo(
    () =>
      theme === "dark"
        ? "bg-[#0b0d11] text-white"
        : "bg-[#eef1f6] text-[#111827]",
    [theme],
  );

  function handleSuggestion(prompt: string) {
    setActiveView("chats");
    setComposerPrefill({
      id: Date.now(),
      text: prompt,
    });
  }

  function markAllNotificationsRead() {
    setNotifications((current) =>
      current.map((item) => ({
        ...item,
        read: true,
      })),
    );
  }

  async function handleSend(message: string, attachmentIds: string[] = []) {
    setActiveView("chats");
    await sendMessage(message, attachmentIds);
  }

  function handleAttachmentsCommitted(
    attachments: Array<{
      id: string;
      name: string;
      size: number;
      mimeType: string;
      detail: string;
      preview?: string;
      kind: "document" | "image";
    }>,
  ) {
    if (!activeProjectId || attachments.length === 0) return;

    addProjectFiles(activeProjectId, attachments);
  }

  function startNewChat() {
    clearChat();
    setActiveConversationId(crypto.randomUUID());
    setActiveView("chats");
  }

  function openConversation(id: string) {
    const conversation = conversationHistory.find(
      (item) => item.id === id,
    );

    if (!conversation) return;

    restoreSnapshot(conversation.snapshot);
    setActiveConversationId(conversation.id);
    setActiveView("chats");
  }

  function toggleConversationPin(id: string) {
    setConversationHistory((current) =>
      current.map((item) =>
        item.id === id
          ? { ...item, pinned: !item.pinned, updatedAt: Date.now() }
          : item,
      ),
    );
  }

  function deleteConversation(id: string) {
    setConversationHistory((current) =>
      current.filter((item) => item.id !== id),
    );

    if (activeConversationId === id) {
      clearChat();
      setActiveConversationId(crypto.randomUUID());
      setActiveView("chats");
    }
  }

  function addProjectFiles(
    projectId: string,
    files: Array<{
      id: string;
      name: string;
      size: number;
      mimeType: string;
      detail: string;
      preview?: string;
      kind: "document" | "image";
    }>,
  ) {
    if (files.length === 0) return;

    setProjects((current) =>
      current.map((project) => {
        if (project.id !== projectId) {
          return project;
        }

        const fileMap = new Map(
          project.files.map((item) => [item.id, item] as const),
        );

        for (const file of files) {
          fileMap.set(file.id, {
            ...file,
            uploadedAt: Date.now(),
          });
        }

        return {
          ...project,
          updatedAt: Date.now(),
          files: [...fileMap.values()].sort(
            (left, right) => right.uploadedAt - left.uploadedAt,
          ),
        };
      }),
    );
  }

  function createProject(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;

    const projectId = crypto.randomUUID();
    const nextProject: ProjectRecord = {
      id: projectId,
      name: trimmed,
      description: "A dedicated workspace for related conversations and files.",
      visibility: "created",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      conversations: [],
      files: [],
    };

    setProjects((current) => [nextProject, ...current]);
  }

  function renameProject(projectId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;

    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? { ...project, name: trimmed, updatedAt: Date.now() }
          : project,
      ),
    );
  }

  function deleteProject(projectId: string) {
    setProjects((current) =>
      current.filter((project) => project.id !== projectId),
    );

    if (activeProjectId === projectId) {
      setActiveProjectId(null);
      clearChat();
      setActiveView("projects");
    }
  }

  function openProject(projectId: string) {
    const project = projects.find((item) => item.id === projectId);

    if (!project) return;

    setActiveProjectId(projectId);

    const latestConversation = project.conversations[0];
    if (latestConversation) {
      restoreSnapshot(latestConversation.snapshot);
    } else {
      clearChat();
    }

    setActiveView("chats");
  }

  const sortedConversations = useMemo(
    () =>
      [...conversationHistory].sort((left, right) => {
        if (left.pinned !== right.pinned) {
          return left.pinned ? -1 : 1;
        }

        return right.updatedAt - left.updatedAt;
      }),
    [conversationHistory],
  );

  const pinnedChats = sortedConversations.filter((item) => item.pinned);
  const recentChats = sortedConversations.filter((item) => !item.pinned);

  const showChatSurface = activeView === "chats";

  return (
    <main
      className={cn(
        "relative flex h-screen overflow-hidden",
        shellClass,
      )}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-0",
          theme === "dark"
            ? "bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.04),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(148,163,184,0.05),_transparent_24%)]"
            : "bg-[radial-gradient(circle_at_top,_rgba(124,58,237,0.08),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(59,130,246,0.06),_transparent_24%)]",
        )}
      />

      <Sidebar
        theme={theme}
        activeView={activeView}
        collapsed={sidebarCollapsed}
        pinnedChats={pinnedChats}
        recentChats={recentChats}
        activeConversationId={activeConversationId}
        onNewChat={startNewChat}
        onNavigate={setActiveView}
        onToggleCollapsed={() =>
          setSidebarCollapsed((current) => !current)
        }
        onOpenCommandPalette={() => setCommandOpen(true)}
        onOpenConversation={openConversation}
        onTogglePinConversation={toggleConversationPin}
        onDeleteConversation={deleteConversation}
      />

      <div className="relative flex flex-1 flex-col">
        <Topbar
          theme={theme}
          activeView={activeView}
          notifications={notifications}
          onMarkAllRead={markAllNotificationsRead}
          onNavigate={setActiveView}
        />

        <div className="flex flex-1 flex-col overflow-hidden">
          {showChatSurface ? (
            messages.length === 0 ? (
              <Welcome
                theme={theme}
                onSuggestionSelect={handleSuggestion}
              />
            ) : (
              <ChatArea
                theme={theme}
                messages={messages}
                loading={loading}
                onEditMessage={editMessage}
                onDeleteMessage={deleteMessage}
                onRetryMessage={retryAssistantMessage}
                onStopGeneration={stopGeneration}
              />
            )
          ) : (
            <WorkspacePanel
              view={activeView}
              theme={theme}
              projects={projects}
              activeProjectId={activeProjectId}
              onExitSettings={() => setActiveView("chats")}
              onCreateProject={createProject}
              onRenameProject={renameProject}
              onDeleteProject={deleteProject}
              onOpenProject={openProject}
            />
          )}
        </div>

        <Composer
          key={activeConversationId}
          theme={theme}
          loading={loading}
          prefill={composerPrefill}
          onSend={handleSend}
          model={model}
          threadId={threadId}
          onModelChange={setModel}
          onAttachmentsCommitted={handleAttachmentsCommitted}
        />
      </div>

      <Dialog.Root
        open={commandOpen}
        onOpenChange={setCommandOpen}
      >
        <AnimatePresence>
          {commandOpen ? (
            <Dialog.Portal forceMount>
              <Dialog.Overlay asChild>
                <motion.div
                  className="fixed inset-0 z-40 bg-black/45 backdrop-blur-md"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                />
              </Dialog.Overlay>

              <Dialog.Content asChild>
                <motion.div
                  initial={{
                    opacity: 0,
                    scale: 0.97,
                    y: 10,
                  }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                    y: 0,
                  }}
                  exit={{
                    opacity: 0,
                    scale: 0.97,
                    y: 10,
                  }}
                  className={cn(
                    "ui-menu-surface fixed left-1/2 top-[18%] z-50 w-[min(92vw,640px)] -translate-x-1/2 p-3 text-[color:var(--foreground)] dark:border-white/[0.04] dark:shadow-none",
                  )}
                >
                  <Command
                    label="Command palette"
                    className="rounded-[16px]"
                  >
                    <div
                      className={cn(
                        "flex items-center gap-3 rounded-[14px] border px-4 py-3.5",
                        theme === "dark"
                          ? "border-white/[0.04] bg-[color:var(--surface)]"
                          : "border-[color:var(--border)] bg-[color:var(--surface)]",
                      )}
                    >
                      <Search
                        size={18}
                        className={
                          theme === "dark"
                            ? "text-zinc-500"
                            : "text-slate-400"
                        }
                      />
                      <Command.Input
                        autoFocus
                        placeholder="Search chats, projects, settings..."
                        className="w-full bg-transparent text-[14px] outline-none placeholder:text-zinc-500"
                      />
                    </div>

                    <Command.List className="mt-3 max-h-[320px] overflow-y-auto">
                      <Command.Empty className="px-3 py-8 text-[14px] text-zinc-400">
                        Nothing matched your search.
                      </Command.Empty>

                      <Command.Group heading="Go to">
                        {commandItems.map((item) => (
                          <Command.Item
                            key={item.label}
                            value={item.label}
                            onSelect={() => {
                              setActiveView(item.view);
                              setCommandOpen(false);
                            }}
                            className={cn(
                              "flex cursor-pointer items-center gap-3 rounded-[14px] px-3 py-2.5 text-[14px] outline-none",
                              theme === "dark"
                                ? "hover:bg-white/6 data-[selected=true]:bg-white/6"
                                : "hover:bg-slate-100 data-[selected=true]:bg-slate-100",
                            )}
                          >
                            <Sparkles
                              size={18}
                              className="text-violet-500"
                            />
                            {item.label}
                          </Command.Item>
                        ))}
                      </Command.Group>
                    </Command.List>
                  </Command>
                </motion.div>
              </Dialog.Content>
            </Dialog.Portal>
          ) : null}
        </AnimatePresence>
      </Dialog.Root>

      <AnimatePresence>
        {utilityMessage ? (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className={cn(
              "ui-menu-surface fixed bottom-6 right-6 z-50 max-w-sm px-5 py-4 text-[color:var(--foreground)] dark:border-white/[0.04] dark:shadow-none",
            )}
          >
            <p className="text-[14px] font-semibold">
              Product action
            </p>
            <p
              className={cn(
                "mt-2 text-[14px] leading-6",
                theme === "dark"
                  ? "text-zinc-400"
                  : "text-slate-600",
              )}
            >
              {utilityMessage}
            </p>
            <button
              onClick={() => setUtilityMessage(null)}
              className="ui-button ui-button-secondary mt-4 h-10 px-3 text-[13px] text-violet-400"
            >
              Dismiss
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </main>
  );
}
