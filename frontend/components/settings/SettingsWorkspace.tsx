"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useTheme } from "next-themes";

import {
  Check,
  CircleHelp,
  Clipboard,
  Database,
  Download,
  HardDrive,
  Import,
  Laptop,
  MessageSquare,
  Moon,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Sun,
  Trash2,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  getActiveChatMode,
  setActiveChatMode,
  type ChatMode,
} from "@/lib/api";

import { useModels } from "@/hooks/useModels";
import { PROVIDER_LABELS } from "@/lib/models";

import {
  DEFAULT_APP_SETTINGS,
  readAppSettings,
  writeAppSettings,
  type AppSettings,
} from "@/lib/settings";

import {
  DEFAULT_PERSONALIZATION,
  getPersonalizationPreferences,
  PERSONALIZATION_STORAGE_KEY,
  type ResponseLength,
  type ResponseTone,
} from "@/lib/personalization";

import { cn } from "@/lib/utils";

type Section =
  | "general"
  | "chat"
  | "personalization"
  | "profile"
  | "privacy"
  | "data"
  | "reset"
  | "help";

type ThemeMode = "system" | "light" | "dark";

type PersonalizationDraft = {
  assistantName: string;
  responseTone: ResponseTone;
  responseLength: ResponseLength;
  customInstructions: string;
  defaultMode: ChatMode;
};

type ProfileDraft = {
  name: string;
  workspaceName: string;
  bio: string;
};

const DEFAULT_PROFILE: ProfileDraft = {
  name: "Hassan Kadri",
  workspaceName: "Personal workspace",
  bio: "",
};

const PROFILE_KEY = "clawbit.profile.v1";

const CHAT_KEYS = [
  "clawbit.conversations.v1",
  "clawbit.conversations.active.v1",
];

const PROJECT_KEYS = [
  "clawbit.projects.v1",
  "clawbit.projects.active.v1",
];

const navigation: {
  id: Section;
  title: string;
  icon: LucideIcon;
  group: "Settings" | "Workspace";
}[] = [
  {
    id: "general",
    title: "General",
    icon: Settings2,
    group: "Settings",
  },
  {
    id: "chat",
    title: "Chat",
    icon: MessageSquare,
    group: "Settings",
  },
  {
    id: "personalization",
    title: "Personalization",
    icon: SlidersHorizontal,
    group: "Settings",
  },
  {
    id: "profile",
    title: "Profile",
    icon: UserRound,
    group: "Settings",
  },
  {
    id: "privacy",
    title: "Privacy & safety",
    icon: ShieldAlert,
    group: "Settings",
  },
  {
    id: "data",
    title: "Data & storage",
    icon: HardDrive,
    group: "Workspace",
  },
  {
    id: "reset",
    title: "Reset",
    icon: RotateCcw,
    group: "Workspace",
  },
  {
    id: "help",
    title: "Help & Docs",
    icon: CircleHelp,
    group: "Workspace",
  },
];

type HelpArticle = {
  id: string;
  category: string;
  title: string;
  summary: string;
  body: string[];
  steps?: string[];
};

const helpArticles: HelpArticle[] = [
  {
    id: "getting-started",
    category: "Getting started",
    title: "Start using Clawbit",
    summary:
      "Create chats, choose a model, upload files, and keep your work organized.",
    body: [
      "Use New chat for a normal conversation and Projects when you want related chats and files grouped together.",
      "Choose a model from the composer. Research mode can be used when you need deeper web research and source checking.",
      "You can attach supported documents and images directly from the composer.",
    ],
    steps: [
      "Open New chat or choose a project.",
      "Choose the model you want to use.",
      "Attach files when the answer should use your documents.",
      "Send the message and continue in the same thread.",
    ],
  },
  {
    id: "projects",
    category: "Projects",
    title: "Projects and project history",
    summary: "Keep related conversations and files together.",
    body: [
      "A project keeps its own conversation history and uploaded file information.",
      "Opening an existing project can restore its most recent conversation.",
      "Use project history when you want to return to an older conversation inside that project.",
    ],
  },
  {
    id: "research",
    category: "Research",
    title: "Research mode",
    summary:
      "Use deeper web research when a question needs current or verified information.",
    body: [
      "Switch to Research mode from the chat mode controls.",
      "Research mode is intended for questions that benefit from multiple searches or source checking.",
      "You can return to Normal mode whenever deeper research is not needed.",
    ],
  },
  {
    id: "mcp",
    category: "Tools & MCP",
    title: "Connect external tools",
    summary:
      "Connect supported services such as GitHub, Notion, Stripe, Google Drive, and Slack.",
    body: [
      "Open Tools to manage MCP connectors.",
      "Token-based connectors ask for credentials in the connector dialog. Google Drive and Slack use OAuth.",
      "Connected MCP tools can then be made available to Clawbit when they are relevant to a conversation.",
    ],
  },
  {
    id: "files",
    category: "Files",
    title: "Upload and use files",
    summary:
      "Attach documents and images so Clawbit can work with them.",
    body: [
      "Use the + button in the composer to select files.",
      "Wait for an upload to finish before sending when you want the answer to use that file.",
      "Files uploaded inside Projects can also appear in the project's Files section.",
    ],
  },
  {
    id: "troubleshooting",
    category: "Troubleshooting",
    title: "Fix common local-development issues",
    summary:
      "Check the frontend, backend, OAuth setup, and browser state.",
    body: [
      "If the UI looks stale, restart the frontend development server and hard refresh the browser.",
      "If chat or uploads fail, confirm the FastAPI backend is running and inspect the first backend error.",
      "OAuth connectors require their configured callback URL to remain valid during local testing.",
    ],
    steps: [
      "Check the browser console for the first frontend error.",
      "Check the backend terminal for the first request error.",
      "Verify environment variables are loaded without printing secret values.",
      "Retry the exact action that failed.",
    ],
  },
  {
    id: "shortcuts",
    category: "Keyboard",
    title: "Keyboard shortcuts",
    summary: "Move around Clawbit faster.",
    body: [
      "Ctrl/Cmd + K opens the command palette.",
      "Enter sends a message from the composer.",
      "Shift + Enter inserts a new line.",
      "Escape closes most menus and dialogs.",
    ],
  },
];

function readProfile(): ProfileDraft {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(PROFILE_KEY) ?? "null",
    );

    return saved && typeof saved === "object"
      ? {
          name:
            typeof saved.name === "string"
              ? saved.name
              : DEFAULT_PROFILE.name,

          workspaceName:
            typeof saved.workspaceName === "string"
              ? saved.workspaceName
              : DEFAULT_PROFILE.workspaceName,

          bio:
            typeof saved.bio === "string" ? saved.bio : "",
        }
      : { ...DEFAULT_PROFILE };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

function createPersonalizationDraft(): PersonalizationDraft {
  return {
    ...getPersonalizationPreferences(),
    defaultMode: getActiveChatMode(),
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SettingsWorkspace({
  onExitSettings,
  initialSection = "general",
}: {
  onExitSettings: () => void;
  initialSection?: Section;
}) {
  const availableModels = useModels();
  const { setTheme } = useTheme();

  const [activeSection, setActiveSection] =
    useState<Section>(initialSection);

  const [search, setSearch] = useState("");

  const [settings, setSettings] =
    useState<AppSettings>(DEFAULT_APP_SETTINGS);

  const [profile, setProfile] =
    useState<ProfileDraft>(DEFAULT_PROFILE);

  const [savedProfile, setSavedProfile] =
    useState<ProfileDraft>(DEFAULT_PROFILE);

  const [personalization, setPersonalization] =
    useState<PersonalizationDraft>({
      ...DEFAULT_PERSONALIZATION,
      defaultMode: "normal",
    });

  const [savedPersonalization, setSavedPersonalization] =
    useState<PersonalizationDraft>({
      ...DEFAULT_PERSONALIZATION,
      defaultMode: "normal",
    });

  const [storageSize, setStorageSize] =
    useState("Calculating...");

  const [status, setStatus] = useState("");

  const [helpSearch, setHelpSearch] = useState("");

  const [helpSelectedId, setHelpSelectedId] =
    useState(helpArticles[0].id);

  const importInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSettings(readAppSettings());

      const saved = readProfile();

      setProfile(saved);
      setSavedProfile(saved);

      const prefs = createPersonalizationDraft();

      setPersonalization(prefs);
      setSavedPersonalization(prefs);

      void refreshStorageSize();
    });

    return () => cancelAnimationFrame(frame);
  }, []);

  function changeSection(id: Section) {
    setActiveSection(id);
    setStatus("");

    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }

  function updateSettings(patch: Partial<AppSettings>) {
    writeAppSettings(patch);
    setSettings(readAppSettings());
  }

  function changeTheme(mode: ThemeMode) {
    setTheme(mode);
    updateSettings({ themeMode: mode });
  }

  function changeChatMode(mode: ChatMode) {
    setActiveChatMode(mode);
    updateSettings({ defaultChatMode: mode });
  }

  /* ==================================================== */
  /* PROFILE                                              */
  /* ==================================================== */

  function saveProfile() {
    const next = {
      name: profile.name.trim() || DEFAULT_PROFILE.name,

      workspaceName:
        profile.workspaceName.trim() ||
        DEFAULT_PROFILE.workspaceName,

      bio: profile.bio.trim(),
    };

    window.localStorage.setItem(
      PROFILE_KEY,
      JSON.stringify(next),
    );

    setProfile(next);
    setSavedProfile(next);

    window.dispatchEvent(
      new CustomEvent("clawbit:profile-updated", {
        detail: next,
      }),
    );

    setStatus("Profile saved.");
  }

  function resetProfile() {
    window.localStorage.setItem(
      PROFILE_KEY,
      JSON.stringify(DEFAULT_PROFILE),
    );

    setProfile({ ...DEFAULT_PROFILE });
    setSavedProfile({ ...DEFAULT_PROFILE });

    window.dispatchEvent(
      new CustomEvent("clawbit:profile-updated", {
        detail: DEFAULT_PROFILE,
      }),
    );

    setStatus("Profile reset.");
  }

  /* ==================================================== */
  /* PERSONALIZATION                                      */
  /* ==================================================== */

  function savePersonalization() {
    const next: PersonalizationDraft = {
      ...personalization,

      assistantName:
        personalization.assistantName.trim() ||
        DEFAULT_PERSONALIZATION.assistantName,

      customInstructions:
        personalization.customInstructions.trim(),
    };

    window.localStorage.setItem(
      PERSONALIZATION_STORAGE_KEY,
      JSON.stringify(next),
    );

    setActiveChatMode(next.defaultMode);

    setPersonalization(next);
    setSavedPersonalization(next);

    window.dispatchEvent(
      new CustomEvent("clawbit:personalization-updated", {
        detail: next,
      }),
    );

    setStatus("Personalization saved.");
  }

  function resetPersonalization() {
    const next: PersonalizationDraft = {
      ...DEFAULT_PERSONALIZATION,
      defaultMode: "normal",
    };

    window.localStorage.setItem(
      PERSONALIZATION_STORAGE_KEY,
      JSON.stringify(next),
    );

    setActiveChatMode("normal");

    setPersonalization(next);
    setSavedPersonalization(next);

    window.dispatchEvent(
      new CustomEvent("clawbit:personalization-updated", {
        detail: next,
      }),
    );

    setStatus("Personalization reset.");
  }

  /* ==================================================== */
  /* STORAGE                                              */
  /* ==================================================== */

  async function refreshStorageSize() {
    try {
      let bytes = 0;

      for (
        let i = 0;
        i < window.localStorage.length;
        i += 1
      ) {
        const key = window.localStorage.key(i);

        if (!key?.startsWith("clawbit.")) continue;

        bytes += new Blob([
          key,
          window.localStorage.getItem(key) ?? "",
        ]).size;
      }

      setStorageSize(formatBytes(bytes));
    } catch {
      setStorageSize("Unavailable");
    }
  }

  /* ==================================================== */
  /* BACKUP                                               */
  /* ==================================================== */

  function exportBackup() {
    const data: Record<string, unknown> = {};

    for (
      let i = 0;
      i < window.localStorage.length;
      i += 1
    ) {
      const key = window.localStorage.key(i);

      if (!key?.startsWith("clawbit.")) continue;

      const raw = window.localStorage.getItem(key);

      if (raw === null) continue;

      try {
        data[key] = JSON.parse(raw);
      } catch {
        data[key] = raw;
      }
    }

    const blob = new Blob(
      [
        JSON.stringify(
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            data,
          },
          null,
          2,
        ),
      ],
      {
        type: "application/json",
      },
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;

    anchor.download = `clawbit-backup-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    URL.revokeObjectURL(url);

    setStatus("Backup exported.");
  }

  async function importBackup(file: File | null) {
    if (!file) return;

    try {
      const parsed = JSON.parse(
        await file.text(),
      ) as {
        data?: Record<string, unknown>;
      };

      const data = parsed.data ?? parsed;

      if (!data || typeof data !== "object") {
        throw new Error("Invalid backup");
      }

      for (const [key, value] of Object.entries(data)) {
        if (!key.startsWith("clawbit.")) continue;

        window.localStorage.setItem(
          key,
          typeof value === "string"
            ? value
            : JSON.stringify(value),
        );
      }

      setStatus("Backup restored. Reloading...");

      window.setTimeout(
        () => window.location.reload(),
        400,
      );
    } catch {
      setStatus("Could not import this backup.");
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
    }
  }

  function removeKeys(keys: string[]) {
    keys.forEach((key) => {
      window.localStorage.removeItem(key);
    });

    void refreshStorageSize();
  }

  function clearChats() {
    if (
      settings.confirmDestructiveActions &&
      !window.confirm("Clear locally saved chats?")
    ) {
      return;
    }

    removeKeys(CHAT_KEYS);
    setStatus("Saved chats cleared.");
  }

  function clearProjects() {
    if (
      settings.confirmDestructiveActions &&
      !window.confirm("Clear all locally saved projects?")
    ) {
      return;
    }

    removeKeys(PROJECT_KEYS);
    setStatus("Projects cleared.");
  }

  function resetSettings() {
    if (
      settings.confirmDestructiveActions &&
      !window.confirm(
        "Reset Clawbit settings to their defaults?",
      )
    ) {
      return;
    }

    writeAppSettings(DEFAULT_APP_SETTINGS);

    setTheme(DEFAULT_APP_SETTINGS.themeMode);

    setActiveChatMode(
      DEFAULT_APP_SETTINGS.defaultChatMode,
    );

    setSettings(readAppSettings());
    setStatus("Settings reset.");
  }

  function clearAllLocalData() {
    if (
      !window.confirm(
        "Clear all locally stored Clawbit data?\n\nThis removes local chats, projects, profile, personalization, settings, Library metadata and other browser-stored Clawbit data. Backend files, databases, environment variables and MCP credentials are not changed.",
      )
    ) {
      return;
    }

    const keys: string[] = [];

    for (
      let i = 0;
      i < window.localStorage.length;
      i += 1
    ) {
      const key = window.localStorage.key(i);

      if (key?.startsWith("clawbit.")) {
        keys.push(key);
      }
    }

    removeKeys(keys);
    window.location.reload();
  }

  /* ==================================================== */
  /* HELP DIAGNOSTICS                                     */
  /* ==================================================== */

  async function copyDiagnostics() {
    const lines = [
      "Clawbit diagnostics",
      `URL: ${window.location.href}`,
      `Browser: ${navigator.userAgent}`,
      `Time: ${new Date().toISOString()}`,

      `Theme: ${
        document.documentElement.classList.contains("dark")
          ? "dark"
          : "light"
      }`,

      `Chat mode: ${getActiveChatMode()}`,
    ];

    try {
      await navigator.clipboard.writeText(
        lines.join("\n"),
      );

      setStatus("Diagnostics copied.");
    } catch {
      setStatus("Clipboard access was blocked.");
    }
  }

  const visibleNav = navigation.filter((entry) =>
    entry.title
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  const filteredArticles = useMemo(() => {
    const query = helpSearch.trim().toLowerCase();

    return helpArticles.filter((article) =>
      [
        article.category,
        article.title,
        article.summary,
        ...article.body,
        ...(article.steps ?? []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [helpSearch]);

  const activeArticle =
    filteredArticles.find(
      (article) => article.id === helpSelectedId,
    ) ??
    filteredArticles[0] ??
    null;

  /* ==================================================== */
  /* UNIFIED MODAL                                        */
  /* ==================================================== */

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onExitSettings();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[1400] bg-black/65 backdrop-blur-[2px]" />

        <Dialog.Content
          aria-describedby="clawbit-modal-description"
          className="fixed left-1/2 top-1/2 z-[1401] flex h-[min(84vh,760px)] w-[min(95vw,980px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-[color:var(--border-strong)] bg-[color:var(--surface)] text-[color:var(--foreground)] shadow-[0_28px_90px_rgba(0,0,0,0.5)] outline-none"
        >
          <Dialog.Title className="sr-only">
            Clawbit workspace settings
          </Dialog.Title>

          <Dialog.Description
            id="clawbit-modal-description"
            className="sr-only"
          >
            Manage settings, personalization, profile and help.
          </Dialog.Description>

          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            aria-label="Import backup"
            className="hidden"
            onChange={(event) => {
              void importBackup(
                event.target.files?.[0] ?? null,
              );
            }}
          />

          {/* LEFT NAVIGATION */}

          <aside className="flex w-[220px] shrink-0 flex-col border-r border-[color:var(--border)] px-3 py-4 max-sm:w-[64px] max-sm:px-2">
            <div className="relative mb-5 max-sm:hidden">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--muted-foreground)]"
              />

              <input
                value={search}
                onChange={(event) =>
                  setSearch(event.target.value)
                }
                placeholder="Search settings"
                aria-label="Search settings"
                className="h-9 w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--background)] pl-9 pr-2 text-xs outline-none"
              />
            </div>

            <nav
              aria-label="Workspace sections"
              className="min-h-0 flex-1 space-y-5 overflow-y-auto"
            >
              {(["Settings", "Workspace"] as const).map(
                (group) => {
                  const choices = visibleNav.filter(
                    (entry) => entry.group === group,
                  );

                  if (!choices.length) return null;

                  return (
                    <div key={group}>
                      <p className="mb-2 px-2 text-[11px] text-[color:var(--muted-foreground)] max-sm:sr-only">
                        {group}
                      </p>

                      <div className="space-y-1">
                        {choices.map(
                          ({ id, title, icon: Icon }) => (
                            <button
                              type="button"
                              key={id}
                              title={title}
                              aria-label={title}
                              aria-current={
                                activeSection === id
                                  ? "page"
                                  : undefined
                              }
                              onClick={() =>
                                changeSection(id)
                              }
                              className={cn(
                                "flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left text-xs transition-colors max-sm:justify-center max-sm:px-0",
                                activeSection === id
                                  ? "bg-[color:var(--accent-hover)] font-semibold text-[color:var(--foreground)]"
                                  : "text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]",
                              )}
                            >
                              <Icon
                                size={17}
                                strokeWidth={1.8}
                                className="shrink-0"
                              />

                              <span className="truncate max-sm:hidden">
                                {title}
                              </span>
                            </button>
                          ),
                        )}
                      </div>
                    </div>
                  );
                },
              )}
            </nav>

            <p className="px-2 text-[11px] text-[color:var(--muted-foreground)] max-sm:hidden">
              Clawbit workspace
            </p>
          </aside>

          {/* RIGHT CONTENT */}

          <div className="flex min-w-0 flex-1 flex-col bg-[color:var(--background)]">
            <div className="flex h-14 shrink-0 items-center justify-end px-5">
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close window"
                  title="Close"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]"
                >
                  <X size={18} />
                </button>
              </Dialog.Close>
            </div>

            <div
              ref={contentRef}
              className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 sm:px-9"
            >
              {/* GENERAL */}

              {activeSection === "general" && (
                <div className="space-y-9">
                  <Heading
                    title="Appearance"
                    description="Choose how Clawbit looks on this device."
                  />

                  <SettingRow
                    label="Theme"
                    description="Follow your device or choose an appearance."
                  >
                    <div className="flex gap-1 rounded-lg bg-[color:var(--surface-alt)] p-1">
                      {(
                        ["system", "light", "dark"] as ThemeMode[]
                      ).map((mode) => (
                        <Choice
                          key={mode}
                          active={
                            settings.themeMode === mode
                          }
                          onClick={() =>
                            changeTheme(mode)
                          }
                        >
                          {mode === "system" ? (
                            <Laptop size={15} />
                          ) : mode === "light" ? (
                            <Sun size={15} />
                          ) : (
                            <Moon size={15} />
                          )}

                          <span className="capitalize">
                            {mode}
                          </span>
                        </Choice>
                      ))}
                    </div>
                  </SettingRow>

                  <div>
                    <Heading
                      title="Notifications"
                      description="Control alerts from workspace activity."
                    />

                    <Toggle
                      label="In-app notifications"
                      description="Show activity in the notification center."
                      checked={settings.notifications}
                      onChange={(notifications) =>
                        updateSettings({ notifications })
                      }
                    />
                  </div>
                </div>
              )}

              {/* CHAT */}

              {activeSection === "chat" && (
                <div className="space-y-7">
                  <Heading
                    title="Chat"
                    description="Defaults applied when you start a new conversation."
                  />

                  <div className="space-y-2 border-b border-[color:var(--border)] pb-6">
                    <label
                      htmlFor="clawbit-default-model"
                      className="text-[13px] font-medium"
                    >
                      Default model
                    </label>

                    <p className="text-xs text-[color:var(--muted-foreground)]">
                      Selected automatically for a new chat.
                    </p>

                    <select
                      id="clawbit-default-model"
                      value={settings.defaultModel}
                      onChange={(event) =>
                        updateSettings({
                          defaultModel:
                            event.target.value,
                        })
                      }
                      className="mt-2 h-10 w-full rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--surface)] px-3 text-xs outline-none"
                    >
                      {availableModels.map((entry) => (
                        <option
                          key={entry.id}
                          value={entry.id}
                          disabled={!entry.available}
                          title={entry.reason}
                        >
                          {`${PROVIDER_LABELS[entry.provider]} / ${entry.label}${entry.available ? "" : " (Unavailable)"}`}
                        </option>
                      ))}
                    </select>
                  </div>

                  <SettingRow
                    label="Default chat mode"
                    description="Mode used for fresh conversations."
                  >
                    <div className="flex gap-1 rounded-lg bg-[color:var(--surface-alt)] p-1">
                      {(
                        ["normal", "research"] as ChatMode[]
                      ).map((mode) => (
                        <Choice
                          key={mode}
                          active={
                            settings.defaultChatMode === mode
                          }
                          onClick={() =>
                            changeChatMode(mode)
                          }
                        >
                          <span className="capitalize">
                            {mode}
                          </span>
                        </Choice>
                      ))}
                    </div>
                  </SettingRow>
                </div>
              )}

              {/* PERSONALIZATION */}

              {activeSection === "personalization" && (
                <div className="space-y-6">
                  <Heading
                    title="Personalization"
                    description="Choose how Clawbit speaks and responds to you."
                  />

                  <label className="block">
                    <Label>Assistant name</Label>

                    <TextField
                      value={
                        personalization.assistantName
                      }
                      maxLength={80}
                      onChange={(value) =>
                        setPersonalization((current) => ({
                          ...current,
                          assistantName: value,
                        }))
                      }
                    />
                  </label>

                  <div>
                    <Label>Default chat mode</Label>

                    <div className="flex flex-wrap gap-2">
                      {(
                        ["normal", "research"] as ChatMode[]
                      ).map((mode) => (
                        <Choice
                          key={mode}
                          active={
                            personalization.defaultMode === mode
                          }
                          onClick={() =>
                            setPersonalization((current) => ({
                              ...current,
                              defaultMode: mode,
                            }))
                          }
                        >
                          <span className="capitalize">
                            {mode}
                          </span>
                        </Choice>
                      ))}
                    </div>
                  </div>

                  <div>
                    <Label>Response tone</Label>

                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          "Balanced",
                          "Friendly",
                          "Professional",
                          "Direct",
                        ] as ResponseTone[]
                      ).map((tone) => (
                        <Choice
                          key={tone}
                          active={
                            personalization.responseTone === tone
                          }
                          onClick={() =>
                            setPersonalization((current) => ({
                              ...current,
                              responseTone: tone,
                            }))
                          }
                        >
                          {tone}
                        </Choice>
                      ))}
                    </div>
                  </div>

                  <div>
                    <Label>Response length</Label>

                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          "Short",
                          "Balanced",
                          "Detailed",
                        ] as ResponseLength[]
                      ).map((length) => (
                        <Choice
                          key={length}
                          active={
                            personalization.responseLength ===
                            length
                          }
                          onClick={() =>
                            setPersonalization((current) => ({
                              ...current,
                              responseLength: length,
                            }))
                          }
                        >
                          {length}
                        </Choice>
                      ))}
                    </div>
                  </div>

                  <label className="block">
                    <Label>Custom instructions</Label>

                    <textarea
                      value={
                        personalization.customInstructions
                      }
                      maxLength={4000}
                      rows={5}
                      onChange={(event) =>
                        setPersonalization((current) => ({
                          ...current,
                          customInstructions:
                            event.target.value,
                        }))
                      }
                      placeholder="How should Clawbit respond?"
                      className="w-full resize-none rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-3 text-xs leading-6 outline-none"
                    />
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <Action
                      icon={Save}
                      disabled={
                        JSON.stringify(personalization) ===
                        JSON.stringify(savedPersonalization)
                      }
                      onClick={savePersonalization}
                    >
                      Save changes
                    </Action>

                    <Action
                      icon={RotateCcw}
                      onClick={resetPersonalization}
                    >
                      Reset
                    </Action>
                  </div>
                </div>
              )}

              {/* PROFILE */}

              {activeSection === "profile" && (
                <div className="space-y-6">
                  <Heading
                    title="Profile"
                    description="Manage the identity shown in your local Clawbit workspace."
                  />

                  <div className="flex items-center gap-3 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[color:var(--border)] bg-[color:var(--surface-alt)] text-sm font-semibold">
                      {profile.name
                        .split(/\s+/)
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((part) =>
                          part[0]?.toUpperCase(),
                        )
                        .join("") || "U"}
                    </div>

                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold">
                        {profile.name || "Your name"}
                      </p>

                      <p className="truncate text-xs text-[color:var(--muted-foreground)]">
                        {profile.workspaceName ||
                          "Personal workspace"}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label>
                      <Label>Display name</Label>

                      <TextField
                        value={profile.name}
                        onChange={(name) =>
                          setProfile((current) => ({
                            ...current,
                            name,
                          }))
                        }
                      />
                    </label>

                    <label>
                      <Label>Workspace label</Label>

                      <TextField
                        value={profile.workspaceName}
                        onChange={(workspaceName) =>
                          setProfile((current) => ({
                            ...current,
                            workspaceName,
                          }))
                        }
                      />
                    </label>
                  </div>

                  <label className="block">
                    <Label>About you</Label>

                    <textarea
                      rows={4}
                      maxLength={280}
                      value={profile.bio}
                      placeholder="A short description for this local workspace."
                      onChange={(event) =>
                        setProfile((current) => ({
                          ...current,
                          bio: event.target.value,
                        }))
                      }
                      className="w-full resize-none rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-3 text-xs leading-6 outline-none"
                    />

                    <p className="mt-1 text-right text-[10px] text-[color:var(--muted-foreground)]">
                      {profile.bio.length}/280
                    </p>
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <Action
                      icon={Save}
                      disabled={
                        JSON.stringify(profile) ===
                        JSON.stringify(savedProfile)
                      }
                      onClick={saveProfile}
                    >
                      Save profile
                    </Action>

                    <Action
                      icon={RotateCcw}
                      onClick={resetProfile}
                    >
                      Reset
                    </Action>
                  </div>
                </div>
              )}

              {/* PRIVACY */}

              {activeSection === "privacy" && (
                <div>
                  <Heading
                    title="Privacy & safety"
                    description="Control confirmations for destructive actions."
                  />

                  <Toggle
                    label="Confirm destructive actions"
                    checked={
                      settings.confirmDestructiveActions
                    }
                    description="Ask before clearing important local data."
                    onChange={(confirmDestructiveActions) =>
                      updateSettings({
                        confirmDestructiveActions,
                      })
                    }
                  />
                </div>
              )}

              {/* DATA */}

              {activeSection === "data" && (
                <div className="space-y-8">
                  <Heading
                    title="Backup & restore"
                    description="Export and restore browser-stored Clawbit data."
                  />

                  <div className="flex flex-wrap gap-2 border-b border-[color:var(--border)] pb-6">
                    <Action
                      icon={Download}
                      onClick={exportBackup}
                    >
                      Export backup
                    </Action>

                    <Action
                      icon={Import}
                      onClick={() =>
                        importInputRef.current?.click()
                      }
                    >
                      Import backup
                    </Action>
                  </div>

                  <div>
                    <Heading
                      title="Local data"
                      description="Manage Clawbit data stored in this browser."
                    />

                    <SettingRow
                      label="Browser storage"
                      description="Estimated size of Clawbit localStorage (not IndexedDB)."
                    >
                      <span className="text-xs font-medium">
                        {storageSize}
                      </span>
                    </SettingRow>

                    <p className="mt-3 text-xs leading-5 text-[color:var(--muted-foreground)]">
                      These controls manage browser data only.
                      Backend uploads, databases, environment
                      variables, and MCP secrets are not included.
                    </p>

                    <div className="mt-5 flex flex-wrap gap-2">
                      <Action
                        icon={MessageSquare}
                        onClick={clearChats}
                      >
                        Clear chats
                      </Action>

                      <Action
                        icon={Database}
                        onClick={clearProjects}
                      >
                        Clear projects
                      </Action>

                      <Action
                        icon={RotateCcw}
                        onClick={resetPersonalization}
                      >
                        Reset personalization
                      </Action>
                    </div>
                  </div>
                </div>
              )}

              {/* RESET */}

              {activeSection === "reset" && (
                <div className="space-y-8">
                  <Heading
                    title="Reset"
                    description="Restore defaults or clear local workspace data."
                  />

                  <div>
                    <p className="mb-2 text-[13px] font-medium">
                      Reset application settings
                    </p>

                    <p className="mb-3 text-xs text-[color:var(--muted-foreground)]">
                      Restore theme, chat defaults, and notifications.
                    </p>

                    <Action
                      icon={RotateCcw}
                      onClick={resetSettings}
                    >
                      Reset settings
                    </Action>
                  </div>

                  <div className="border-t border-[color:var(--border)] pt-6">
                    <p className="mb-2 text-[13px] font-medium">
                      Clear all browser data
                    </p>

                    <p className="mb-3 text-xs leading-5 text-[color:var(--muted-foreground)]">
                      Remove Clawbit browser data. Backend files,
                      databases, and MCP credentials are not deleted.
                    </p>

                    <button
                      type="button"
                      onClick={clearAllLocalData}
                      className="inline-flex h-9 items-center gap-2 rounded-lg border border-red-500/25 px-3 text-xs font-medium text-red-500 hover:bg-red-500/[0.08]"
                    >
                      <Trash2 size={15} />
                      Clear all local data
                    </button>
                  </div>
                </div>
              )}

              {/* HELP & DOCS */}

              {activeSection === "help" && (
                <div>
                  <Heading
                    title="Help & Docs"
                    description="Guides for chats, Projects, Research, files, MCP, and shortcuts."
                  />

                  <div className="relative mb-5">
                    <Search
                      size={15}
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--muted-foreground)]"
                    />

                    <input
                      value={helpSearch}
                      onChange={(event) =>
                        setHelpSearch(event.target.value)
                      }
                      placeholder="Search Help & Docs"
                      aria-label="Search Help & Docs"
                      className="h-10 w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] pl-10 pr-3 text-xs outline-none"
                    />
                  </div>

                  <div className="grid gap-3 lg:grid-cols-[190px_minmax(0,1fr)]">
                    <nav
                      aria-label="Help articles"
                      className="space-y-1 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-2"
                    >
                      {filteredArticles.map((article) => (
                        <button
                          key={article.id}
                          type="button"
                          onClick={() =>
                            setHelpSelectedId(article.id)
                          }
                          className={cn(
                            "w-full rounded-lg px-2.5 py-2 text-left text-xs hover:bg-[color:var(--accent-hover)]",
                            activeArticle?.id === article.id &&
                              "bg-[color:var(--accent-hover)] font-medium",
                          )}
                        >
                          <span className="mb-1 block text-[10px] text-[color:var(--muted-foreground)]">
                            {article.category}
                          </span>

                          {article.title}
                        </button>
                      ))}

                      {!filteredArticles.length && (
                        <p className="px-2 py-5 text-xs text-[color:var(--muted-foreground)]">
                          No matching articles.
                        </p>
                      )}
                    </nav>

                    <article className="min-h-[280px] rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
                      {activeArticle ? (
                        <>
                          <p className="text-[10px] uppercase tracking-wider text-[color:var(--muted-foreground)]">
                            {activeArticle.category}
                          </p>

                          <h3 className="mt-2 text-[15px] font-semibold">
                            {activeArticle.title}
                          </h3>

                          <p className="mt-2 text-xs leading-5 text-[color:var(--muted-foreground)]">
                            {activeArticle.summary}
                          </p>

                          <div className="mt-4 space-y-3">
                            {activeArticle.body.map((body) => (
                              <p
                                key={body}
                                className="text-xs leading-6"
                              >
                                {body}
                              </p>
                            ))}
                          </div>

                          {activeArticle.steps && (
                            <ol className="mt-5 list-decimal space-y-2 border-t border-[color:var(--border)] py-4 pl-5 text-xs leading-5">
                              {activeArticle.steps.map((step) => (
                                <li key={step}>{step}</li>
                              ))}
                            </ol>
                          )}
                        </>
                      ) : (
                        <p className="text-xs text-[color:var(--muted-foreground)]">
                          Select an article.
                        </p>
                      )}
                    </article>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
                    <div>
                      <p className="text-xs font-medium">
                        Need debugging information?
                      </p>

                      <p className="mt-1 text-[11px] text-[color:var(--muted-foreground)]">
                        Copy non-secret browser diagnostics.
                      </p>
                    </div>

                    <Action
                      icon={Clipboard}
                      onClick={() => {
                        void copyDiagnostics();
                      }}
                    >
                      Copy diagnostics
                    </Action>
                  </div>
                </div>
              )}

              {status && (
                <p
                  role="status"
                  className="mt-7 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2.5 text-xs text-[color:var(--muted-foreground)]"
                >
                  {status}
                </p>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ====================================================== */
/* SHARED PRESENTATION COMPONENTS                         */
/* ====================================================== */

function Heading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-6">
      <h2 className="text-[18px] font-semibold tracking-[-0.02em]">
        {title}
      </h2>

      <p className="mt-1.5 text-xs leading-5 text-[color:var(--muted-foreground)]">
        {description}
      </p>
    </div>
  );
}

function Label({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <span className="mb-2 block text-xs font-medium text-[color:var(--muted-foreground)]">
      {children}
    </span>
  );
}

function TextField({
  value,
  onChange,
  maxLength,
}: {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <input
      value={value}
      maxLength={maxLength}
      onChange={(event) =>
        onChange(event.target.value)
      }
      className="h-10 w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-3 text-xs outline-none focus:border-[color:var(--border-strong)]"
    />
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--border)] py-4">
      <div className="min-w-[180px] flex-1">
        <p className="text-[13px] font-medium">
          {label}
        </p>

        <p className="mt-1 text-xs leading-5 text-[color:var(--muted-foreground)]">
          {description}
        </p>
      </div>

      {children}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <SettingRow
      label={label}
      description={description}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 rounded-full border transition-colors",
          checked
            ? "border-[color:var(--foreground)] bg-[color:var(--foreground)]"
            : "border-[color:var(--border-strong)] bg-[color:var(--surface-alt)]",
        )}
      >
        <span
          className={cn(
            "absolute top-[3px] h-4 w-4 rounded-full transition-all",
            checked
              ? "left-[23px] bg-[color:var(--background)]"
              : "left-[3px] bg-[color:var(--muted-foreground)]",
          )}
        />
      </button>
    </SettingRow>
  );
}

function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-xs transition-colors",
        active
          ? "border-[color:var(--border-strong)] bg-[color:var(--surface-alt)] font-semibold"
          : "border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]",
      )}
    >
      {children}
      {active && <Check size={12} />}
    </button>
  );
}

function Action({
  icon: Icon,
  onClick,
  disabled,
  children,
}: {
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--surface)] px-3 text-xs font-medium hover:bg-[color:var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon size={14} />
      {children}
    </button>
  );
}