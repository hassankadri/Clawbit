import {
  Bell,
  Blocks,
  BrainCircuit,
  CreditCard,
  FolderKanban,
  HelpCircle,
  LayoutTemplate,
  Lock,
  Palette,
  PlugZap,
  Plus,
  Pencil,
  Search,
  Settings2,
  Trash2,
  MessageSquare,
  Clock3,
  X,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type AppView =
  | "chats"
  | "projects"
  | "plugins"
  | "customize"
  | "settings"
  | "help";

interface ProjectConversation {
  id: string;
  title: string;
  preview: string;
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
  visibility: "created" | "shared";
  createdAt: number;
  updatedAt: number;
  conversations: ProjectConversation[];
  files: ProjectFile[];
}

interface WorkspacePanelProps {
  view: AppView;
  theme: Theme;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  onExitSettings: () => void;
  onCreateProject: (name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  onOpenProject: (id: string) => void;
}

const SettingsThemeContext = createContext<Theme>("dark");

const viewConfig: Record<
  AppView,
  {
    title: string;
    description: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    sections: string[];
  }
> = {
  chats: {
    title: "Chats",
    description:
      "Search, revisit, and organize every conversation in one place.",
    icon: BrainCircuit,
    sections: [
      "Recent conversations",
      "Pinned chats",
      "Temporary threads",
    ],
  },
  projects: {
    title: "Projects",
    description:
      "Group conversations, files, and deliverables into structured workspaces.",
    icon: FolderKanban,
    sections: [
      "Project templates",
      "Shared context",
      "Team workspaces",
    ],
  },
  plugins: {
    title: "Plugins",
    description:
      "Browse installed tools, discover new integrations, and keep them ready for the workspace.",
    icon: PlugZap,
    sections: [
      "Installed plugins",
      "Available plugins",
      "Permissions",
    ],
  },
  customize: {
    title: "Customize",
    description:
      "Shape Clawbit around your team, workflows, and preferences.",
    icon: Palette,
    sections: [
      "Branding",
      "Prompt presets",
      "Agent behavior",
    ],
  },
  settings: {
    title: "Settings",
    description:
      "A complete settings surface with real navigation and future-ready sections.",
    icon: Settings2,
    sections: [
      "General",
      "Appearance",
      "Models",
      "Memory",
      "MCP",
      "Plugins",
      "Keyboard",
      "Notifications",
      "Privacy",
      "Billing",
      "About",
    ],
  },
  help: {
    title: "Help & Docs",
    description:
      "Documentation, onboarding tips, and support resources in one place.",
    icon: HelpCircle,
    sections: [
      "Quickstart",
      "Shortcuts",
      "Troubleshooting",
    ],
  },
};

type SettingsSectionId =
  | "general"
  | "appearance"
  | "models"
  | "memory"
  | "mcp"
  | "plugins"
  | "keyboard"
  | "notifications"
  | "privacy"
  | "billing"
  | "about";

const settingsSections: Record<
  SettingsSectionId,
  {
    title: string;
    body: string;
    details: string[];
    actionLabel: string;
    icon: React.ComponentType<{ size?: number }>;
  }
> = {
  general: {
    title: "General",
    body: "Core workspace defaults and account basics.",
    details: ["Workspace name", "Language", "Auto-save", "Draft behavior"],
    actionLabel: "General preferences saved.",
    icon: Settings2,
  },
  appearance: {
    title: "Appearance",
    body: "Theme, density, and presentation controls.",
    details: ["Theme sync", "Compact layout", "Motion level", "Contrast"],
    actionLabel: "Appearance preset updated.",
    icon: Palette,
  },
  models: {
    title: "Models",
    body: "Choose the model defaults for chat and tools.",
    details: ["Default chat model", "Fallback model", "Reasoning mode", "Multimodal"],
    actionLabel: "Model defaults refreshed.",
    icon: BrainCircuit,
  },
  memory: {
    title: "Memory",
    body: "Control what the assistant remembers between chats.",
    details: ["Memory enabled", "Temporary chats", "Reference limits", "Clear history"],
    actionLabel: "Memory preference updated.",
    icon: Lock,
  },
  mcp: {
    title: "MCP",
    body: "Manage external tool servers and connectors.",
    details: ["Active servers", "Permissions", "Scopes", "Health checks"],
    actionLabel: "MCP workspace opened.",
    icon: PlugZap,
  },
  plugins: {
    title: "Plugins",
    body: "Enable approved extensions and capabilities.",
    details: ["Marketplace", "Installed plugins", "Allowed actions", "Sandboxing"],
    actionLabel: "Plugin manager refreshed.",
    icon: Blocks,
  },
  keyboard: {
    title: "Keyboard",
    body: "Shortcuts for moving quickly through the product.",
    details: ["Command palette", "New chat", "Search", "Submit message"],
    actionLabel: "Shortcut overlay opened.",
    icon: LayoutTemplate,
  },
  notifications: {
    title: "Notifications",
    body: "Release notes and workspace activity preferences.",
    details: ["Unread alerts", "Digest mode", "Sound", "Badge behavior"],
    actionLabel: "Notification settings updated.",
    icon: Bell,
  },
  privacy: {
    title: "Privacy",
    body: "Temporary chats, history, and data handling controls.",
    details: ["Temporary mode", "Data retention", "Export data", "Delete chats"],
    actionLabel: "Privacy controls updated.",
    icon: Lock,
  },
  billing: {
    title: "Billing",
    body: "Plan usage and future upgrade options.",
    details: ["Current plan", "Usage summary", "Invoices", "Upgrade options"],
    actionLabel: "Billing overview opened.",
    icon: CreditCard,
  },
  about: {
    title: "About",
    body: "Product version, support links, and build information.",
    details: ["Version", "Release channel", "Support", "Status"],
    actionLabel: "About panel shown.",
    icon: HelpCircle,
  },
};

const settingsOrder: SettingsSectionId[] = [
  "general",
  "appearance",
  "models",
  "memory",
  "mcp",
  "plugins",
  "keyboard",
  "notifications",
  "privacy",
  "billing",
  "about",
];

type PluginId =
  | "google-drive"
  | "slack"
  | "notion"
  | "github"
  | "figma"
  | "box"
  | "atlassian-rovo"
  | "teams";

type PluginEntry = {
  id: PluginId;
  name: string;
  description: string;
  category: string;
  source: string;
  installed: boolean;
  enabled: boolean;
};

type CustomizationState = {
  assistantName: string;
  assistantPersonality: string;
  systemPrompt: string;
  responseLength: string;
  responseTone: string;
  temperature: number;
  memoryEnabled: boolean;
  defaultModel: string;
};

type HelpArticle = {
  id: string;
  category: string;
  title: string;
  summary: string;
  tags: string[];
  content: string[];
  steps?: string[];
  shortcuts?: Array<{ keys: string; action: string }>;
  popular?: boolean;
};

const pluginStorageKey = "clawbit.plugins.state.v1";
const customizationStorageKey = "clawbit.customization.state.v1";

const defaultCustomizationState: CustomizationState = {
  assistantName: "Clawbit",
  assistantPersonality: "Helpful, precise, and collaborative",
  systemPrompt:
    "You are Clawbit, a helpful AI assistant. Answer clearly, use uploaded context when available, and ask concise follow-up questions when needed.",
  responseLength: "Balanced",
  responseTone: "Professional",
  temperature: 45,
  memoryEnabled: true,
  defaultModel: "Gemini 3.5 Flash",
};

const helpArticles: HelpArticle[] = [
  {
    id: "getting-started",
    category: "Getting Started",
    title: "Start using Clawbit",
    summary: "Create your first chat, choose a model, and keep useful context ready.",
    tags: ["quickstart", "onboarding", "first chat"],
    popular: true,
    content: [
      "Use the composer at the bottom of the page to ask questions, draft content, analyze files, or continue existing work.",
      "Pick a model from the model selector before sending if you want a different speed or reasoning profile.",
      "Use Projects when a task needs persistent files, instructions, and related conversations.",
    ],
    steps: [
      "Open New chat from the sidebar.",
      "Choose a model from the composer.",
      "Attach files when you want answers grounded in your documents.",
      "Move longer work into a Project so context stays organized.",
    ],
  },
  {
    id: "chat",
    category: "Chat",
    title: "Chat basics and message controls",
    summary: "Send messages, stream responses, use Markdown, and manage conversations.",
    tags: ["chat", "messages", "markdown", "streaming"],
    popular: true,
    content: [
      "User messages appear on the right and assistant messages appear on the left in a continuous conversation flow.",
      "Markdown, lists, links, and code blocks are preserved in assistant responses.",
      "If a response looks incomplete, send a follow-up with the missing detail instead of restarting the thread.",
    ],
  },
  {
    id: "projects",
    category: "Projects",
    title: "Organize work with Projects",
    summary: "Create workspaces that keep conversations and uploaded files together.",
    tags: ["projects", "workspace", "files", "organization"],
    popular: true,
    content: [
      "Projects are local workspaces for a topic, client, assignment, or build. Each project can keep its own conversations and files.",
      "Use project names that describe the outcome, such as Resume Review, BookMySeat Pitch, or Research Notes.",
    ],
    steps: [
      "Open Projects from the sidebar.",
      "Select New Project and give it a clear name.",
      "Open the project before starting related chats or adding files.",
      "Rename or delete projects from the project card actions.",
    ],
  },
  {
    id: "plugins",
    category: "Plugins",
    title: "Manage Plugins",
    summary: "Enable, disable, and discover local plugin integrations.",
    tags: ["plugins", "integrations", "tools"],
    content: [
      "Plugins extend the workspace with extra capabilities. The Plugins page separates installed plugins from available plugins.",
      "Toggle a plugin on when you want it active. Toggle it off to keep it installed but inactive.",
      "Plugin states are stored locally and remain after refresh.",
    ],
  },
  {
    id: "mcp",
    category: "MCP",
    title: "Use MCP safely",
    summary: "Understand server discovery, permissions, approvals, and health checks.",
    tags: ["mcp", "servers", "permissions", "tools"],
    content: [
      "MCP connects external tool servers to the assistant. Keep approval prompts enabled for actions that can read, write, or modify external state.",
      "If a server does not appear, verify it is running and check the MCP settings health status.",
    ],
    steps: [
      "Open Settings, then MCP.",
      "Confirm server mode and permissions.",
      "Keep health checks enabled while debugging connections.",
      "Review scopes before allowing a new server.",
    ],
  },
  {
    id: "models",
    category: "Models",
    title: "Choose the right model",
    summary: "Balance speed, cost, multimodal support, and reasoning quality.",
    tags: ["models", "gemini", "reasoning", "selection"],
    content: [
      "Use Flash-Lite for fast everyday questions. Use stronger models for long files, complex reasoning, coding, or detailed analysis.",
      "Set your default model in Customize or Settings, then override it per chat from the composer when needed.",
    ],
  },
  {
    id: "file-uploads",
    category: "File Uploads",
    title: "Upload and ask questions about files",
    summary: "Attach documents and images so the assistant can answer from their content.",
    tags: ["files", "upload", "pdf", "documents", "images"],
    popular: true,
    content: [
      "Use the paperclip button in the composer to attach files. Once uploaded, ask direct questions such as summarize this resume or extract action items.",
      "For best results, ask specific questions and mention the filename when multiple files are attached.",
      "If upload fails, confirm the backend is running, the file type is supported, and the file is not locked by another application.",
    ],
    steps: [
      "Start the backend service.",
      "Attach a PDF, document, image, or text file.",
      "Wait for the chip to show as attached rather than failed.",
      "Ask a question grounded in the uploaded content.",
    ],
  },
  {
    id: "keyboard-shortcuts",
    category: "Keyboard Shortcuts",
    title: "Keyboard shortcuts",
    summary: "Move faster with composer, navigation, and workspace shortcuts.",
    tags: ["shortcuts", "keyboard", "productivity"],
    content: [
      "Shortcuts help you move around without leaving the keyboard. Availability can vary by browser and operating system.",
    ],
    shortcuts: [
      { keys: "Enter", action: "Send message when send-on-enter is enabled" },
      { keys: "Shift + Enter", action: "Insert a new line in the composer" },
      { keys: "Ctrl / Cmd + K", action: "Open quick search or command palette when enabled" },
      { keys: "Esc", action: "Close modals and overlays" },
    ],
  },
  {
    id: "settings",
    category: "Settings",
    title: "Configure workspace settings",
    summary: "Update appearance, models, memory, privacy, billing, and more.",
    tags: ["settings", "preferences", "appearance", "privacy"],
    content: [
      "Settings are organized by section in the left navigation. Changes apply to the local workspace experience unless a backend integration is added later.",
      "Use Appearance for theme controls, Models for default model behavior, and Privacy for data handling preferences.",
    ],
  },
  {
    id: "privacy",
    category: "Privacy",
    title: "Privacy and local data",
    summary: "Understand what is saved locally and what is not connected yet.",
    tags: ["privacy", "localStorage", "data", "memory"],
    content: [
      "Current UI preferences such as plugins, projects, and customization settings are stored locally in the browser.",
      "Backend AI behavior is not modified by Customize yet, so saved preferences are UI-level until backend wiring is added.",
      "Clear browser site data if you want to reset local settings.",
    ],
  },
  {
    id: "troubleshooting",
    category: "Troubleshooting",
    title: "Fix common issues",
    summary: "Resolve upload failures, invisible controls, backend errors, and build problems.",
    tags: ["troubleshooting", "errors", "backend", "upload failed"],
    popular: true,
    content: [
      "Most local issues come from the backend not running, missing dependencies, blocked worker processes, or stale browser state.",
      "If the UI looks stale after a change, stop and restart the dev server, then hard refresh the browser.",
    ],
    steps: [
      "Run the frontend dev server and confirm it loads without console errors.",
      "Run the backend service before testing uploads.",
      "Install missing Python packages if uvicorn or FastAPI is unavailable.",
      "Check terminal logs for the first failing request.",
    ],
  },
  {
    id: "faq",
    category: "FAQ",
    title: "Frequently asked questions",
    summary: "Answers to common setup, model, upload, and customization questions.",
    tags: ["faq", "questions", "support"],
    content: [
      "Can Customize change the AI backend now? Not yet. It saves preferences locally and is ready for backend wiring later.",
      "Can Projects keep files after refresh? Yes, project metadata and supported file context are persisted locally.",
      "Why does build show a lockfile warning? The repo has lockfiles in both the root and frontend folder, so Next warns about workspace root inference.",
    ],
  },
  {
    id: "release-notes",
    category: "Release Notes",
    title: "Recent updates and changelog",
    summary: "Track recent product improvements and UI fixes.",
    tags: ["release notes", "updates", "changelog"],
    content: [
      "Projects now support local creation, rename, delete, and opening.",
      "Plugins now include installed and available sections with local enable states.",
      "Customize now saves assistant preferences locally.",
      "Settings modal layout and theme contrast have been improved across light and dark modes.",
    ],
  },
];

const defaultPluginCatalog: PluginEntry[] = [
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Attach files from Drive and keep project sources within reach.",
    category: "Storage",
    source: "Google",
    installed: true,
    enabled: true,
  },
  {
    id: "slack",
    name: "Slack",
    description: "Pull in workspace conversations and summarize action items quickly.",
    category: "Communication",
    source: "Slack",
    installed: true,
    enabled: false,
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search your docs, project notes, and knowledge bases on demand.",
    category: "Knowledge",
    source: "Notion",
    installed: true,
    enabled: true,
  },
  {
    id: "github",
    name: "GitHub",
    description: "Review pull requests, inspect repositories, and surface code context.",
    category: "Engineering",
    source: "GitHub",
    installed: true,
    enabled: true,
  },
  {
    id: "figma",
    name: "Figma",
    description: "Read design frames, annotations, and visual references from your files.",
    category: "Design",
    source: "Figma",
    installed: false,
    enabled: false,
  },
  {
    id: "box",
    name: "Box",
    description: "Access shared assets and keep file-heavy workflows organized.",
    category: "Storage",
    source: "Box",
    installed: false,
    enabled: false,
  },
  {
    id: "atlassian-rovo",
    name: "Atlassian Rovo",
    description: "Connect Jira and Confluence content for planning and support.",
    category: "Operations",
    source: "Atlassian",
    installed: false,
    enabled: false,
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    description: "Bring meeting notes, threads, and collaboration into one place.",
    category: "Collaboration",
    source: "Microsoft",
    installed: false,
    enabled: false,
  },
];

type SettingsState = {
  general: {
    workspaceName: string;
    language: string;
    autosave: boolean;
    draftBehavior: string;
  };
  appearance: {
    themeMode: string;
    density: number;
    motion: string;
    highContrast: boolean;
  };
  models: {
    defaultModel: string;
    fallbackModel: string;
    reasoningDepth: number;
    multimodal: boolean;
  };
  memory: {
    memoryEnabled: boolean;
    temporaryChats: boolean;
    referenceLimit: number;
    historyWindow: string;
  };
  mcp: {
    serverMode: string;
    autoConnect: boolean;
    approvalRequired: boolean;
    healthChecks: boolean;
  };
  plugins: {
    pluginsEnabled: boolean;
    sandboxLevel: string;
    autoUpdate: boolean;
    installMode: string;
  };
  keyboard: {
    commandPalette: boolean;
    sendOnEnter: boolean;
    shortcutDensity: string;
    quickActions: boolean;
  };
  notifications: {
    unreadAlerts: boolean;
    digestMode: string;
    sound: boolean;
    badgeBehavior: string;
  };
  privacy: {
    temporaryMode: boolean;
    retention: string;
    analytics: boolean;
    dataExport: string;
  };
  billing: {
    plan: string;
    usageCap: number;
    invoicing: string;
    overageProtection: boolean;
  };
  about: {
    releaseChannel: string;
    status: string;
    supportEmail: string;
    buildId: string;
  };
};

export default function WorkspacePanel({
  view,
  theme,
  projects,
  activeProjectId,
  onExitSettings,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onOpenProject,
}: WorkspacePanelProps) {
  const isDarkTheme = theme === "dark";
  const config = viewConfig[view];
  const Icon = config.icon;
  const [selectedSection, setSelectedSection] = useState<SettingsSectionId>("general");
  const activeSection = settingsSections[selectedSection];
  const ActiveSectionIcon = activeSection.icon;
  const [statusMessage, setStatusMessage] = useState(activeSection.actionLabel);
  const [pluginSearch, setPluginSearch] = useState("");
  const [pluginCatalog, setPluginCatalog] =
    useState<PluginEntry[]>(defaultPluginCatalog);
  const [customizationState, setCustomizationState] =
    useState<CustomizationState>(defaultCustomizationState);
  const [customizationStatus, setCustomizationStatus] =
    useState("Customization preferences loaded.");
  const [helpSearch, setHelpSearch] = useState("");
  const [selectedHelpArticleId, setSelectedHelpArticleId] =
    useState(helpArticles[0].id);
  const pluginsHydratedRef = useRef(false);
  const [settingsState, setSettingsState] = useState<SettingsState>({
    general: {
      workspaceName: "Clawbit Team",
      language: "English",
      autosave: true,
      draftBehavior: "Auto-save drafts",
    },
    appearance: {
      themeMode: "System",
      density: 62,
      motion: "Balanced",
      highContrast: false,
    },
    models: {
      defaultModel: "Gemini 3.5 Flash",
      fallbackModel: "Gemini 3.1 Flash-Lite",
      reasoningDepth: 68,
      multimodal: true,
    },
    memory: {
      memoryEnabled: true,
      temporaryChats: false,
      referenceLimit: 8,
      historyWindow: "30 days",
    },
    mcp: {
      serverMode: "Auto-detect",
      autoConnect: false,
      approvalRequired: true,
      healthChecks: true,
    },
    plugins: {
      pluginsEnabled: true,
      sandboxLevel: "Strict",
      autoUpdate: true,
      installMode: "Recommended only",
    },
    keyboard: {
      commandPalette: true,
      sendOnEnter: true,
      shortcutDensity: "Standard",
      quickActions: true,
    },
    notifications: {
      unreadAlerts: true,
      digestMode: "Daily",
      sound: false,
      badgeBehavior: "Unread only",
    },
    privacy: {
      temporaryMode: false,
      retention: "30 days",
      analytics: false,
      dataExport: "JSON",
    },
    billing: {
      plan: "Free",
      usageCap: 72,
      invoicing: "Monthly",
      overageProtection: true,
    },
    about: {
      releaseChannel: "Stable",
      status: "All systems operational",
      supportEmail: "support@clawbit.ai",
      buildId: "2026.07.17",
    },
  });

  useEffect(() => {
    try {
      const rawValue = window.localStorage.getItem(pluginStorageKey);

      if (!rawValue) {
        pluginsHydratedRef.current = true;
        return;
      }

      const parsed = JSON.parse(rawValue) as Array<
        Pick<PluginEntry, "id" | "installed" | "enabled">
      >;
      const savedById = new Map(parsed.map((item) => [item.id, item]));

      queueMicrotask(() => {
        pluginsHydratedRef.current = true;

        setPluginCatalog(
          defaultPluginCatalog.map((plugin) => {
            const saved = savedById.get(plugin.id);

            if (!saved) {
              return plugin;
            }

            return {
              ...plugin,
              installed: saved.installed,
              enabled: saved.installed ? saved.enabled : false,
            };
          }),
        );
      });
    } catch {
      queueMicrotask(() => {
        pluginsHydratedRef.current = true;
        setPluginCatalog(defaultPluginCatalog);
      });
    }
  }, []);

  useEffect(() => {
    if (!pluginsHydratedRef.current) return;

    window.localStorage.setItem(
      pluginStorageKey,
      JSON.stringify(
        pluginCatalog.map(({ id, installed, enabled }) => ({
          id,
          installed,
          enabled,
        })),
      ),
    );
  }, [pluginCatalog]);

  useEffect(() => {
    try {
      const rawValue = window.localStorage.getItem(customizationStorageKey);

      if (!rawValue) {
        return;
      }

      const parsed = JSON.parse(rawValue) as Partial<CustomizationState>;

      queueMicrotask(() => {
        setCustomizationState({
          ...defaultCustomizationState,
          ...parsed,
        });
        setCustomizationStatus("Saved customization preferences loaded.");
      });
    } catch {
      queueMicrotask(() => {
        setCustomizationState(defaultCustomizationState);
        setCustomizationStatus("Using default customization preferences.");
      });
    }
  }, []);

  const normalizedPluginSearch = pluginSearch.trim().toLowerCase();
  const filteredPlugins = useMemo(() => {
    if (!normalizedPluginSearch) {
      return pluginCatalog;
    }

    return pluginCatalog.filter((plugin) =>
      [plugin.name, plugin.description, plugin.category, plugin.source]
        .join(" ")
        .toLowerCase()
        .includes(normalizedPluginSearch),
    );
  }, [normalizedPluginSearch, pluginCatalog]);

  const installedPlugins = filteredPlugins.filter((plugin) => plugin.installed);
  const availablePlugins = filteredPlugins.filter((plugin) => !plugin.installed);
  const normalizedHelpSearch = helpSearch.trim().toLowerCase();
  const filteredHelpArticles = useMemo(() => {
    if (!normalizedHelpSearch) {
      return helpArticles;
    }

    return helpArticles.filter((article) =>
      [
        article.category,
        article.title,
        article.summary,
        article.tags.join(" "),
        article.content.join(" "),
        article.steps?.join(" ") ?? "",
        article.shortcuts?.map((shortcut) => `${shortcut.keys} ${shortcut.action}`).join(" ") ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedHelpSearch),
    );
  }, [normalizedHelpSearch]);
  const activeHelpArticle =
    filteredHelpArticles.find((article) => article.id === selectedHelpArticleId) ??
    filteredHelpArticles[0] ??
    null;

  function updateSection<K extends keyof SettingsState>(
    section: K,
    patch: Partial<SettingsState[K]>,
    message: string,
  ) {
    setSettingsState((current) => ({
      ...current,
      [section]: {
        ...current[section],
        ...patch,
      },
    }));
    setStatusMessage(message);
  }

  function togglePlugin(id: PluginId, enabled: boolean) {
    setPluginCatalog((current) =>
      current.map((plugin) => {
        if (plugin.id !== id) {
          return plugin;
        }

        if (enabled) {
          return {
            ...plugin,
            installed: true,
            enabled: true,
          };
        }

        return {
          ...plugin,
          enabled: false,
        };
      }),
    );
  }

  function updateCustomization(patch: Partial<CustomizationState>) {
    setCustomizationState((current) => ({
      ...current,
      ...patch,
    }));
    setCustomizationStatus("You have unsaved customization changes.");
  }

  function saveCustomization() {
    window.localStorage.setItem(
      customizationStorageKey,
      JSON.stringify(customizationState),
    );
    setCustomizationStatus("Customization preferences saved locally.");
  }

  return (
    <SettingsThemeContext.Provider value={theme}>
      <div
        className={cn(
          "flex h-full min-h-0 w-full",
          view === "settings"
            ? "items-center justify-center overflow-hidden p-4 sm:p-5 lg:p-6"
            : "mx-auto max-w-6xl flex-col overflow-y-auto px-5 pb-6 pt-6 lg:px-8",
        )}
      >
        <div
          className={cn(
            "ui-surface-elevated relative min-h-0 dark:border-white/[0.05] dark:shadow-[0_16px_36px_rgba(0,0,0,0.14)]",
            view === "settings"
              ? "flex h-[min(720px,calc(100vh-3rem))] w-[min(1120px,calc(100vw-3rem))] flex-col overflow-hidden p-5 sm:p-6"
              : view === "plugins"
                ? "border-0 bg-transparent p-0 shadow-none dark:border-0 dark:bg-transparent dark:shadow-none"
                : view === "customize"
                  ? "border-0 bg-transparent p-0 shadow-none dark:border-0 dark:bg-transparent dark:shadow-none"
                  : view === "help"
                    ? "border-0 bg-transparent p-0 shadow-none dark:border-0 dark:bg-transparent dark:shadow-none"
              : "p-6 lg:p-8",
          )}
        >
        {view === "settings" ? (
          <button
            type="button"
            onClick={onExitSettings}
            className="ui-icon-button absolute right-5 top-5 z-10 h-9 w-9 text-slate-600 hover:border-violet-300 hover:bg-violet-50 hover:text-slate-950 dark:text-zinc-400 dark:hover:text-white"
            aria-label="Exit settings"
            title="Exit settings"
          >
            <X size={16} />
          </button>
        ) : null}

        {view === "projects" ? (
          <ProjectsWorkspace
            theme={theme}
            projects={projects}
            activeProjectId={activeProjectId}
            onCreateProject={onCreateProject}
            onRenameProject={onRenameProject}
            onDeleteProject={onDeleteProject}
            onOpenProject={onOpenProject}
          />
        ) : view === "customize" ? (
          <CustomizeWorkspace
            theme={theme}
            state={customizationState}
            status={customizationStatus}
            onChange={updateCustomization}
            onSave={saveCustomization}
          />
        ) : view === "help" ? (
          <HelpWorkspace
            theme={theme}
            search={helpSearch}
            articles={filteredHelpArticles}
            activeArticle={activeHelpArticle}
            popularArticles={helpArticles.filter((article) => article.popular)}
            releaseNotes={helpArticles.find((article) => article.id === "release-notes")}
            onSearchChange={setHelpSearch}
            onSelectArticle={setSelectedHelpArticleId}
          />
        ) : view === "plugins" ? (
          <PluginsWorkspace
            theme={theme}
            search={pluginSearch}
            installedPlugins={installedPlugins}
            availablePlugins={availablePlugins}
            onSearchChange={setPluginSearch}
            onTogglePlugin={togglePlugin}
          />
        ) : view !== "settings" ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
            <div className="max-w-2xl">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex h-14 w-14 items-center justify-center rounded-[16px] bg-[color:var(--accent-hover)] text-violet-400">
                    <Icon size={24} />
                  </div>
                  <h1 className="mt-6 text-[24px] font-semibold tracking-tight text-slate-900 dark:text-white lg:text-[26px]">
                    {config.title}
                  </h1>
                  <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-600 dark:text-zinc-400">
                    {config.description}
                  </p>
                </div>
              </div>
            </div>

            <div className="w-full ui-card p-5 dark:border-white/[0.05] dark:bg-white/[0.02] dark:shadow-none">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-zinc-500">
                Available Sections
              </p>
              <div className="mt-4 max-h-[320px] space-y-2 overflow-y-auto pr-1">
                {config.sections.map((section) => (
                  <div
                    key={section}
                    className="rounded-[14px] border border-[color:var(--border)] px-4 py-3 text-[14px] leading-6 text-slate-700 dark:border-white/[0.05] dark:bg-white/[0.03] dark:text-zinc-300"
                  >
                    {section}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {view === "settings" ? (
          <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[280px_minmax(0,1fr)]">
            <div
              className={cn(
                "ui-card h-full min-h-0 overflow-y-auto p-4 shadow-[0_10px_24px_rgba(15,23,42,0.06)] dark:border-white/[0.05] dark:bg-[color:var(--surface)] dark:shadow-none",
                isDarkTheme
                  ? "bg-[color:var(--surface)] dark:bg-[color:var(--surface)]"
                  : "border-slate-300 bg-[#f3f5f9]",
              )}
            >
              <p className={cn("text-[11px] font-semibold uppercase tracking-[0.24em]", isDarkTheme ? "text-zinc-500" : "text-slate-900")}>
                Settings
              </p>
              <div className="mt-4 space-y-2">
                {settingsOrder.map((sectionId) => {
                  const section = settingsSections[sectionId];
                  const active = sectionId === selectedSection;

                  return (
                    <button
                      key={sectionId}
                      type="button"
                      onClick={() => {
                        setSelectedSection(sectionId);
                        setStatusMessage(settingsSections[sectionId].actionLabel);
                      }}
                      className={cn(
                        "flex w-full items-start justify-between rounded-[14px] border px-3 py-3 text-left transition hover:-translate-y-px",
                        isDarkTheme
                          ? active
                            ? "border-white/[0.05] bg-white/[0.04] text-white"
                            : "border-transparent bg-transparent text-zinc-400 hover:border-transparent hover:bg-white/[0.03] hover:text-zinc-300"
                          : active
                            ? "border-violet-500/20 bg-[color:var(--accent-hover)] text-slate-950"
                            : "border-slate-300 bg-white text-slate-900 hover:border-slate-400 hover:bg-slate-100 hover:text-slate-950",
                      )}
                    >
                      <div>
                        <p className={cn("text-[14px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-900")}>
                          {section.title}
                        </p>
                        <p className={cn("mt-1 text-[12px] leading-5 opacity-100", isDarkTheme ? "text-zinc-400" : "text-slate-700")}>
                          {section.body}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              className={cn(
                "ui-card h-full min-h-0 min-w-0 overflow-y-auto p-6 shadow-[0_10px_24px_rgba(15,23,42,0.06)] dark:border-white/[0.05] dark:bg-[color:var(--surface)] dark:shadow-none",
                isDarkTheme
                  ? "bg-[color:var(--surface)] dark:bg-[color:var(--surface)]"
                  : "border-slate-300 bg-[#f8fafc]",
              )}
            >
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-2xl">
                  <div className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-[color:var(--accent-hover)] text-violet-500">
                    <ActiveSectionIcon size={22} />
                  </div>
                  <h3 className={cn("mt-4 text-[20px] font-semibold tracking-tight", isDarkTheme ? "text-white" : "text-slate-950")}>
                    {activeSection.title}
                  </h3>
                  <p className={cn("mt-2 text-[15px] leading-7", isDarkTheme ? "text-zinc-400" : "text-slate-700")}>
                    {activeSection.body}
                  </p>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {activeSection.details.map((detail) => (
                      <span
                        key={detail}
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-[12px] font-medium",
                          isDarkTheme
                            ? "border-white/[0.05] bg-transparent text-zinc-300"
                            : "border-slate-300 bg-white text-slate-900",
                        )}
                      >
                        {detail}
                      </span>
                    ))}
                  </div>
                </div>

                <div
                  className={cn(
                    "rounded-[16px] border px-4 py-3 text-[13px]",
                    isDarkTheme
                    ? "border-white/[0.05] bg-[color:var(--surface)] text-zinc-300"
                      : "border-slate-300 bg-white text-slate-900",
                  )}
                >
                  {statusMessage}
                </div>
              </div>

              <div className="mt-6">
                {selectedSection === "general" ? (
                  <SettingsGrid>
                    <TextSetting
                      label="Workspace name"
                      description="Displayed across the sidebar and workspace shell."
                      value={settingsState.general.workspaceName}
                      onChange={(value) =>
                        updateSection("general", { workspaceName: value }, `Workspace renamed to ${value}.`)
                      }
                    />
                    <SelectSetting
                      label="Language"
                      description="Choose the language for prompts and UI labels."
                      value={settingsState.general.language}
                      options={["English", "Spanish", "French", "German"]}
                      onChange={(value) =>
                        updateSection("general", { language: value }, `Language set to ${value}.`)
                      }
                    />
                    <SwitchSetting
                      label="Auto-save drafts"
                      description="Keep draft changes saved while you type."
                      checked={settingsState.general.autosave}
                      onChange={(checked) =>
                        updateSection("general", { autosave: checked }, `Auto-save ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SegmentSetting
                      label="Draft behavior"
                      description="Control how new prompts are prepared."
                      value={settingsState.general.draftBehavior}
                      options={["Auto-save drafts", "Ask before save", "Temporary only"]}
                      onChange={(value) =>
                        updateSection("general", { draftBehavior: value }, `${value} selected.`)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                {selectedSection === "appearance" ? (
                  <SettingsGrid>
                    <SegmentSetting
                      label="Theme mode"
                      description="Match your system or lock the appearance."
                      value={settingsState.appearance.themeMode}
                      options={["System", "Light", "Dark"]}
                      onChange={(value) =>
                        updateSection("appearance", { themeMode: value }, `${value} theme selected.`)
                      }
                    />
                    <RangeSetting
                      label="Density"
                      description="Adjust the amount of space between controls."
                      value={settingsState.appearance.density}
                      min={40}
                      max={90}
                      onChange={(value) =>
                        updateSection("appearance", { density: value }, `Density set to ${value}%.`)
                      }
                    />
                    <SelectSetting
                      label="Motion"
                      description="Reduce or expand animation intensity."
                      value={settingsState.appearance.motion}
                      options={["Reduced", "Balanced", "Expressive"]}
                      onChange={(value) =>
                        updateSection("appearance", { motion: value }, `${value} motion selected.`)
                      }
                    />
                    <SwitchSetting
                      label="High contrast"
                      description="Boost contrast for clearer separation."
                      checked={settingsState.appearance.highContrast}
                      onChange={(checked) =>
                        updateSection("appearance", { highContrast: checked }, `High contrast ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                {selectedSection === "models" ? (
                  <SettingsGrid>
                    <SelectSetting
                      label="Default model"
                      description="Used for new chats unless changed manually."
                      value={settingsState.models.defaultModel}
                      options={["Gemini 3.5 Flash", "Gemini 3.1 Flash-Lite"]}
                      onChange={(value) =>
                        updateSection("models", { defaultModel: value }, `${value} set as default model.`)
                      }
                    />
                    <SelectSetting
                      label="Fallback model"
                      description="Used when the primary model is unavailable."
                      value={settingsState.models.fallbackModel}
                      options={["Gemini 3.1 Flash-Lite", "Gemini 3.5 Flash"]}
                      onChange={(value) =>
                        updateSection("models", { fallbackModel: value }, `${value} set as fallback model.`)
                      }
                    />
                    <RangeSetting
                      label="Reasoning depth"
                      description="Balance speed against deeper analysis."
                      value={settingsState.models.reasoningDepth}
                      min={20}
                      max={100}
                      onChange={(value) =>
                        updateSection("models", { reasoningDepth: value }, `Reasoning depth set to ${value}%.`)
                      }
                    />
                    <SwitchSetting
                      label="Multimodal support"
                      description="Allow images and other rich inputs when available."
                      checked={settingsState.models.multimodal}
                      onChange={(checked) =>
                        updateSection("models", { multimodal: checked }, `Multimodal ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                {selectedSection === "memory" ? (
                  <SettingsGrid>
                    <SwitchSetting
                      label="Memory"
                      description="Let the assistant remember useful context."
                      checked={settingsState.memory.memoryEnabled}
                      onChange={(checked) =>
                        updateSection("memory", { memoryEnabled: checked }, `Memory ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SwitchSetting
                      label="Temporary chats"
                      description="Keep selected chats ephemeral."
                      checked={settingsState.memory.temporaryChats}
                      onChange={(checked) =>
                        updateSection("memory", { temporaryChats: checked }, `Temporary chats ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <RangeSetting
                      label="Reference limit"
                      description="How many recent references to preserve."
                      value={settingsState.memory.referenceLimit}
                      min={2}
                      max={20}
                      onChange={(value) =>
                        updateSection("memory", { referenceLimit: value }, `Reference limit set to ${value}.`)
                      }
                    />
                    <SelectSetting
                      label="History window"
                      description="Select how long conversation history stays visible."
                      value={settingsState.memory.historyWindow}
                      options={["7 days", "30 days", "90 days"]}
                      onChange={(value) =>
                        updateSection("memory", { historyWindow: value }, `History window set to ${value}.`)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                {selectedSection === "mcp" ? (
                  <SettingsGrid>
                    <SelectSetting
                      label="Server mode"
                      description="Control how tool servers are discovered."
                      value={settingsState.mcp.serverMode}
                      options={["Auto-detect", "Manual only", "Workspace linked"]}
                      onChange={(value) =>
                        updateSection("mcp", { serverMode: value }, `${value} selected for server mode.`)
                      }
                    />
                    <SwitchSetting
                      label="Auto connect"
                      description="Connect trusted servers when the workspace opens."
                      checked={settingsState.mcp.autoConnect}
                      onChange={(checked) =>
                        updateSection("mcp", { autoConnect: checked }, `Auto connect ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SwitchSetting
                      label="Approval required"
                      description="Ask before tools can take actions."
                      checked={settingsState.mcp.approvalRequired}
                      onChange={(checked) =>
                        updateSection("mcp", { approvalRequired: checked }, `Approval requirements ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SwitchSetting
                      label="Health checks"
                      description="Keep an eye on server availability."
                      checked={settingsState.mcp.healthChecks}
                      onChange={(checked) =>
                        updateSection("mcp", { healthChecks: checked }, `Health checks ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                {selectedSection === "plugins" ? (
                  <SettingsGrid>
                    <SwitchSetting
                      label="Plugins"
                      description="Enable marketplace-installed extensions."
                      checked={settingsState.plugins.pluginsEnabled}
                      onChange={(checked) =>
                        updateSection("plugins", { pluginsEnabled: checked }, `Plugins ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SelectSetting
                      label="Sandbox level"
                      description="Choose how much access installed plugins get."
                      value={settingsState.plugins.sandboxLevel}
                      options={["Strict", "Balanced", "Permissive"]}
                      onChange={(value) =>
                        updateSection("plugins", { sandboxLevel: value }, `${value} sandbox selected.`)
                      }
                    />
                    <SwitchSetting
                      label="Auto update"
                      description="Keep approved plugins up to date automatically."
                      checked={settingsState.plugins.autoUpdate}
                      onChange={(checked) =>
                        updateSection("plugins", { autoUpdate: checked }, `Auto update ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SegmentSetting
                      label="Install mode"
                      description="Choose what gets surfaced first."
                      value={settingsState.plugins.installMode}
                      options={["Recommended only", "All approved", "Manual review"]}
                      onChange={(value) =>
                        updateSection("plugins", { installMode: value }, `${value} selected.`)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                {selectedSection === "keyboard" ? (
                  <SettingsGrid>
                    <SwitchSetting
                      label="Command palette"
                      description="Keep the global shortcut available."
                      checked={settingsState.keyboard.commandPalette}
                      onChange={(checked) =>
                        updateSection("keyboard", { commandPalette: checked }, `Command palette ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SwitchSetting
                      label="Send on Enter"
                      description="Pressing Enter submits the prompt."
                      checked={settingsState.keyboard.sendOnEnter}
                      onChange={(checked) =>
                        updateSection("keyboard", { sendOnEnter: checked }, `Send on Enter ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SelectSetting
                      label="Shortcut density"
                      description="Show more shortcuts or keep it simple."
                      value={settingsState.keyboard.shortcutDensity}
                      options={["Compact", "Standard", "Expanded"]}
                      onChange={(value) =>
                        updateSection("keyboard", { shortcutDensity: value }, `${value} shortcut density selected.`)
                      }
                    />
                    <SwitchSetting
                      label="Quick actions"
                      description="Surface useful commands near the composer."
                      checked={settingsState.keyboard.quickActions}
                      onChange={(checked) =>
                        updateSection("keyboard", { quickActions: checked }, `Quick actions ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                {selectedSection === "notifications" ? (
                  <SettingsGrid>
                    <SwitchSetting
                      label="Unread alerts"
                      description="Keep product updates visible."
                      checked={settingsState.notifications.unreadAlerts}
                      onChange={(checked) =>
                        updateSection("notifications", { unreadAlerts: checked }, `Unread alerts ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SelectSetting
                      label="Digest mode"
                      description="How often you want updates grouped together."
                      value={settingsState.notifications.digestMode}
                      options={["Instant", "Daily", "Weekly"]}
                      onChange={(value) =>
                        updateSection("notifications", { digestMode: value }, `${value} digest selected.`)
                      }
                    />
                    <SwitchSetting
                      label="Sound"
                      description="Play a subtle sound on important updates."
                      checked={settingsState.notifications.sound}
                      onChange={(checked) =>
                        updateSection("notifications", { sound: checked }, `Notification sound ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SegmentSetting
                      label="Badge behavior"
                      description="Choose how the top bar badge behaves."
                      value={settingsState.notifications.badgeBehavior}
                      options={["Unread only", "All updates", "Off"]}
                      onChange={(value) =>
                        updateSection("notifications", { badgeBehavior: value }, `${value} badge behavior selected.`)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                {selectedSection === "privacy" ? (
                  <SettingsGrid>
                    <SwitchSetting
                      label="Temporary mode"
                      description="Make chats ephemeral by default."
                      checked={settingsState.privacy.temporaryMode}
                      onChange={(checked) =>
                        updateSection("privacy", { temporaryMode: checked }, `Temporary mode ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SelectSetting
                      label="Retention"
                      description="How long chat history stays available."
                      value={settingsState.privacy.retention}
                      options={["7 days", "30 days", "90 days"]}
                      onChange={(value) =>
                        updateSection("privacy", { retention: value }, `Retention set to ${value}.`)
                      }
                    />
                    <SwitchSetting
                      label="Analytics"
                      description="Share anonymous usage trends."
                      checked={settingsState.privacy.analytics}
                      onChange={(checked) =>
                        updateSection("privacy", { analytics: checked }, `Analytics sharing ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                    <SelectSetting
                      label="Export format"
                      description="Choose the default export package."
                      value={settingsState.privacy.dataExport}
                      options={["JSON", "CSV", "Markdown"]}
                      onChange={(value) =>
                        updateSection("privacy", { dataExport: value }, `${value} export selected.`)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                {selectedSection === "billing" ? (
                  <SettingsGrid>
                    <SelectSetting
                      label="Plan"
                      description="Choose the workspace subscription tier."
                      value={settingsState.billing.plan}
                      options={["Free", "Pro", "Team"]}
                      onChange={(value) =>
                        updateSection("billing", { plan: value }, `${value} plan selected.`)
                      }
                    />
                    <RangeSetting
                      label="Usage cap"
                      description="Set your monthly usage target."
                      value={settingsState.billing.usageCap}
                      min={25}
                      max={250}
                      onChange={(value) =>
                        updateSection("billing", { usageCap: value }, `Usage cap set to ${value}%.`)
                      }
                    />
                    <SelectSetting
                      label="Invoicing"
                      description="How your workspace would be billed."
                      value={settingsState.billing.invoicing}
                      options={["Monthly", "Quarterly", "Annual"]}
                      onChange={(value) =>
                        updateSection("billing", { invoicing: value }, `${value} invoicing selected.`)
                      }
                    />
                    <SwitchSetting
                      label="Overage protection"
                      description="Pause usage before unexpected charges."
                      checked={settingsState.billing.overageProtection}
                      onChange={(checked) =>
                        updateSection("billing", { overageProtection: checked }, `Overage protection ${checked ? "enabled" : "disabled"}.`)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                {selectedSection === "about" ? (
                  <SettingsGrid>
                    <SelectSetting
                      label="Release channel"
                      description="Stay on stable or preview builds."
                      value={settingsState.about.releaseChannel}
                      options={["Stable", "Preview"]}
                      onChange={(value) =>
                        updateSection("about", { releaseChannel: value }, `${value} release channel selected.`)
                      }
                    />
                    <TextSetting
                      label="Support email"
                      description="Where workspace alerts will be sent."
                      value={settingsState.about.supportEmail}
                      onChange={(value) =>
                        updateSection("about", { supportEmail: value }, `Support email updated to ${value}.`)
                      }
                    />
                    <TextSetting
                      label="Build ID"
                      description="Current product build reference."
                      value={settingsState.about.buildId}
                      onChange={(value) =>
                        updateSection("about", { buildId: value }, `Build ID updated to ${value}.`)
                      }
                    />
                    <SelectSetting
                      label="Status"
                      description="Track the current workspace health."
                      value={settingsState.about.status}
                      options={["All systems operational", "Minor issues", "Maintenance window"]}
                      onChange={(value) =>
                        updateSection("about", { status: value }, value)
                      }
                    />
                  </SettingsGrid>
                ) : null}

                <div className="mt-6 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setSelectedSection("general")}
                    className="ui-button ui-button-secondary h-10 px-4 text-[13px] text-slate-950 dark:text-zinc-300"
                  >
                    Reset Section
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStatusMessage(`${activeSection.title} changes applied.`);
                    }}
                    className={cn(
                      "ui-button ui-button-primary h-10 px-4 text-[13px] border border-violet-500/30 bg-[linear-gradient(135deg,#6d28d9,#5b21b6)] text-white",
                      theme === "dark"
                        ? "shadow-[0_14px_30px_rgba(0,0,0,0.24)]"
                        : "shadow-[0_14px_30px_rgba(91,33,182,0.32)]",
                    )}
                  >
                    Apply Changes
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-8 rounded-[18px] border border-dashed border-slate-300 px-6 py-8 text-[15px] leading-7 text-slate-600 dark:border-white/10 dark:text-zinc-400">
            This workspace area is wired up and navigable now. Deeper functionality for{" "}
            <span className="font-semibold text-slate-900 dark:text-white">
              {config.title}
            </span>{" "}
            is queued as the next product phase rather than left as a dead click target.
          </div>
        )}
      </div>
      </div>
    </SettingsThemeContext.Provider>
  );
}

function ProjectsWorkspace({
  theme,
  projects,
  activeProjectId,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onOpenProject,
}: {
  theme: Theme;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  onCreateProject: (name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  onOpenProject: (id: string) => void;
}) {
  const isDarkTheme = theme === "dark";
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"all" | "created" | "shared">("all");
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();

    return [...projects]
      .filter((project) => {
        if (tab === "created") return project.visibility === "created";
        if (tab === "shared") return project.visibility === "shared";
        return true;
      })
      .filter((project) => {
        if (!query) return true;

        return [
          project.name,
          project.description,
          project.conversations.map((item) => item.title).join(" "),
          project.files.map((item) => item.name).join(" "),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }, [projects, search, tab]);

  function startCreate() {
    setEditingId(null);
    setDraftName("");
    setIsCreating(true);
  }

  function startRename(project: ProjectRecord) {
    setIsCreating(false);
    setEditingId(project.id);
    setDraftName(project.name);
  }

  function cancelForm() {
    setIsCreating(false);
    setEditingId(null);
    setDraftName("");
  }

  function submitForm() {
    const trimmed = draftName.trim();
    if (!trimmed) return;

    if (editingId) {
      onRenameProject(editingId, trimmed);
    } else {
      onCreateProject(trimmed);
    }

    cancelForm();
  }

  const emptyText =
    projects.length === 0
      ? "Create your first project to group conversations and files in one place."
      : "No projects match your current search or tab.";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-[color:var(--accent-hover)] text-violet-500">
            <FolderKanban size={22} />
          </div>
          <h3 className={cn("mt-4 text-[20px] font-semibold tracking-tight", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
            Projects
          </h3>
          <p className={cn("mt-2 text-[15px] leading-7", isDarkTheme ? "text-zinc-400" : "text-slate-700")}>
            Organize related chats, files, and context into reusable workspaces
            that stay available after refresh.
          </p>
        </div>

        <button
          type="button"
          onClick={startCreate}
          className="ui-button ui-button-primary h-10 px-4 text-[13px] border border-violet-500/30 bg-[linear-gradient(135deg,#6d28d9,#5b21b6)] text-white dark:shadow-none"
        >
          <Plus size={16} />
          New Project
        </button>
      </div>

      <div
        className={cn(
          "flex items-center gap-3 rounded-[14px] border px-4 py-3",
          isDarkTheme
            ? "border-white/[0.04] bg-[#11151b]"
            : "border-slate-300 bg-white",
        )}
      >
        <Search size={18} className={isDarkTheme ? "text-zinc-500" : "text-slate-400"} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search projects..."
          className={cn(
            "w-full bg-transparent text-[14px] outline-none placeholder:text-zinc-500",
            isDarkTheme ? "text-zinc-100" : "text-slate-950 placeholder:text-slate-500",
          )}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          ["all", "All"],
          ["created", "Created by me"],
          ["shared", "Shared"],
        ].map(([value, label]) => {
          const active = tab === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value as typeof tab)}
              className={cn(
                "rounded-full border px-3 py-2 text-[12px] font-medium transition",
                active
                  ? "border-violet-500/20 bg-[color:var(--accent-hover)] text-violet-500"
                  : isDarkTheme
                    ? "border-white/[0.04] bg-[color:var(--surface)] text-zinc-300 hover:border-white/[0.05] hover:bg-white/[0.03]"
                    : "border-slate-300 bg-white text-slate-900 hover:border-violet-300 hover:bg-violet-50 hover:text-slate-950",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {(isCreating || editingId) ? (
        <div
          className={cn(
            "rounded-[16px] border p-4",
            isDarkTheme
              ? "border-white/[0.04] bg-[color:var(--surface)]"
              : "border-slate-300 bg-white",
          )}
        >
          <p className={cn("text-[13px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
            {editingId ? "Rename project" : "Create project"}
          </p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="Project name"
              className={cn(
                "ui-input w-full text-[13px]",
                isDarkTheme ? "border-white/[0.04] bg-[#11151b] text-zinc-100" : "bg-white text-slate-900",
              )}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={submitForm}
                className="ui-button ui-button-primary h-10 px-4 text-[13px] border border-violet-500/30 bg-[linear-gradient(135deg,#6d28d9,#5b21b6)] text-white dark:shadow-none"
              >
                {editingId ? "Save" : "Create"}
              </button>
              <button
                type="button"
                onClick={cancelForm}
                className="ui-button ui-button-secondary h-10 px-4 text-[13px] text-slate-950 dark:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {filteredProjects.length === 0 ? (
        <div
          className={cn(
            "rounded-[18px] border px-6 py-10 text-[14px] leading-7",
            isDarkTheme
              ? "border-white/[0.04] bg-[color:var(--surface)] text-zinc-400"
              : "border-slate-300 bg-white text-slate-600",
          )}
        >
          {emptyText}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-2">
          {filteredProjects.map((project) => {
            const selected = project.id === activeProjectId;
            return (
              <div
                key={project.id}
                className={cn(
                  "rounded-[16px] border p-4 transition",
                  selected
                    ? "border-white/[0.06] bg-white/[0.04]"
                    : isDarkTheme
                      ? "border-white/[0.04] bg-[color:var(--surface)]"
                      : "border-slate-300 bg-white",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className={cn("truncate text-[15px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
                        {project.name}
                      </p>
                      <span
                        className={cn(
                          "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]",
                          project.visibility === "shared"
                            ? "bg-violet-500/12 text-violet-400"
                            : isDarkTheme
                              ? "bg-white/[0.06] text-zinc-100"
                              : "bg-slate-200 text-slate-700",
                        )}
                      >
                        {project.visibility === "shared" ? "Shared" : "Created"}
                      </span>
                    </div>
                    <p className={cn("mt-2 text-[13px] leading-6", isDarkTheme ? "text-zinc-400" : "text-slate-600")}>
                      {project.description}
                    </p>
                  </div>

                  {selected ? (
                    <span className="rounded-full bg-white/[0.06] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-100">
                      Active
                    </span>
                  ) : null}
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className={cn("rounded-[14px] border px-3 py-3", isDarkTheme ? "border-white/[0.04] bg-[#11151b]" : "border-slate-300 bg-[color:var(--panel)]")}>
                    <div className="flex items-center gap-2 text-[12px] text-zinc-400">
                      <MessageSquare size={14} />
                      Conversations
                    </div>
                    <p className="mt-2 text-[18px] font-semibold text-white">{project.conversations.length}</p>
                  </div>
                  <div className={cn("rounded-[14px] border px-3 py-3", isDarkTheme ? "border-white/[0.04] bg-[#11151b]" : "border-slate-300 bg-[color:var(--panel)]")}>
                    <div className="flex items-center gap-2 text-[12px] text-zinc-400">
                      <Clock3 size={14} />
                      Files
                    </div>
                    <p className="mt-2 text-[18px] font-semibold text-white">{project.files.length}</p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenProject(project.id)}
                    className="ui-button ui-button-primary h-9 px-3 text-[12px] border border-violet-500/30 bg-[linear-gradient(135deg,#6d28d9,#5b21b6)] text-white dark:shadow-none"
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={() => startRename(project)}
                    className="ui-button ui-button-secondary h-9 px-3 text-[12px] text-slate-950 dark:text-zinc-300"
                  >
                    <Pencil size={14} />
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete project \"${project.name}\"?`)) {
                        onDeleteProject(project.id);
                      }
                    }}
                    className="ui-button ui-button-secondary h-9 px-3 text-[12px] text-slate-950 dark:text-zinc-300"
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SettingsGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}

function SettingCard({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  const theme = useContext(SettingsThemeContext);
  const isDarkTheme = theme === "dark";
  return (
    <div className={cn("rounded-[18px] border p-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)] dark:shadow-none", isDarkTheme ? "border-white/[0.05] bg-[color:var(--surface)]" : "border-slate-300 bg-white")}>
      <div className="min-w-0">
        <p className={cn("text-[14px] font-semibold", isDarkTheme ? "text-white" : "text-slate-950")}>
          {label}
        </p>
        <p className={cn("mt-1 text-[12px] leading-5", isDarkTheme ? "text-zinc-400" : "text-slate-700")}>
          {description}
        </p>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function SwitchSetting({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const theme = useContext(SettingsThemeContext);
  const isDarkTheme = theme === "dark";
  return (
    <SettingCard label={label} description={description}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "flex h-11 w-full items-center justify-between rounded-[14px] border px-4 text-left",
          checked
            ? "border-violet-500/20 bg-[color:var(--accent-hover)] text-violet-500"
            : isDarkTheme
          ? "border-white/[0.05] bg-[color:var(--surface)] text-zinc-300 hover:border-white/[0.06] hover:bg-[color:var(--surface)]"
              : "border-slate-300 bg-white text-slate-900 hover:border-violet-300 hover:bg-violet-50",
        )}
      >
        <span className="text-[13px] font-medium">
          {checked ? "Enabled" : "Disabled"}
        </span>
        <span
          className={cn(
            "flex h-6 w-11 items-center rounded-full p-1 transition",
            checked ? "bg-violet-500" : "bg-slate-400 dark:bg-white/10",
          )}
        >
          <span
            className={cn(
              "h-4 w-4 rounded-full bg-white transition",
              checked ? "translate-x-5" : "translate-x-0",
            )}
          />
        </span>
      </button>
    </SettingCard>
  );
}

function SelectSetting({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const theme = useContext(SettingsThemeContext);
  return (
    <SettingCard label={label} description={description}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "ui-input w-full text-[13px]",
          theme === "dark"
            ? "border-white/[0.05] bg-[color:var(--surface)] text-zinc-100"
            : "bg-white text-slate-900",
        )}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </SettingCard>
  );
}

function SegmentSetting({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const theme = useContext(SettingsThemeContext);
  const isDarkTheme = theme === "dark";
  return (
    <SettingCard label={label} description={description}>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = option === value;

          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              className={cn(
                "rounded-full border px-3 py-2 text-[12px] font-medium transition",
                active
                  ? "border-violet-500/20 bg-[color:var(--accent-hover)] text-violet-500"
                  : isDarkTheme
                    ? "border-white/[0.05] bg-[color:var(--surface)] text-zinc-300 hover:border-white/[0.06] hover:bg-white/[0.04]"
                    : "border-slate-300 bg-white text-slate-900 hover:border-violet-300 hover:bg-violet-50 hover:text-slate-950",
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </SettingCard>
  );
}

function RangeSetting({
  label,
  description,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const theme = useContext(SettingsThemeContext);
  return (
    <SettingCard label={label} description={description}>
      <div className="flex items-center justify-between gap-3">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full accent-violet-500"
        />
        <span
          className={cn(
            "min-w-14 rounded-full border px-3 py-1.5 text-center text-[12px] font-medium",
            theme === "dark"
              ? "border-white/[0.05] bg-transparent text-zinc-300"
              : "border-slate-300 bg-white text-slate-900",
          )}
        >
          {value}
        </span>
      </div>
    </SettingCard>
  );
}

function TextSetting({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const theme = useContext(SettingsThemeContext);
  return (
    <SettingCard label={label} description={description}>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "ui-input w-full text-[13px]",
          theme === "dark"
            ? "border-white/[0.05] bg-[color:var(--surface)] text-zinc-100"
            : "bg-white text-slate-900",
        )}
      />
    </SettingCard>
  );
}

function TextareaSetting({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const theme = useContext(SettingsThemeContext);
  return (
    <SettingCard label={label} description={description}>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={7}
        className={cn(
          "ui-input min-h-40 w-full resize-y py-3 text-[13px] leading-6",
          theme === "dark"
            ? "border-white/[0.05] bg-[color:var(--surface)] text-zinc-100"
            : "bg-white text-slate-900",
        )}
      />
    </SettingCard>
  );
}

function HelpWorkspace({
  theme,
  search,
  articles,
  activeArticle,
  popularArticles,
  releaseNotes,
  onSearchChange,
  onSelectArticle,
}: {
  theme: Theme;
  search: string;
  articles: HelpArticle[];
  activeArticle: HelpArticle | null;
  popularArticles: HelpArticle[];
  releaseNotes?: HelpArticle;
  onSearchChange: (value: string) => void;
  onSelectArticle: (id: string) => void;
}) {
  const isDarkTheme = theme === "dark";
  const quickActions = [
    {
      label: "Report a Bug",
      action: () => window.open("mailto:support@clawbit.ai?subject=Bug%20Report"),
    },
    {
      label: "Request a Feature",
      action: () => window.open("mailto:support@clawbit.ai?subject=Feature%20Request"),
    },
    {
      label: "Contact Support",
      action: () => window.open("mailto:support@clawbit.ai"),
    },
    {
      label: "Open GitHub",
      action: () => window.open("https://github.com", "_blank", "noopener,noreferrer"),
    },
    {
      label: "View Documentation",
      action: () => onSelectArticle("getting-started"),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-[color:var(--accent-hover)] text-violet-500">
            <HelpCircle size={22} />
          </div>
          <h3
            className={cn(
              "mt-4 text-[20px] font-semibold tracking-tight",
              isDarkTheme ? "text-zinc-100" : "text-slate-950",
            )}
          >
            Help & Docs
          </h3>
          <p
            className={cn(
              "mt-2 text-[15px] leading-7",
              isDarkTheme ? "text-zinc-400" : "text-slate-700",
            )}
          >
            Search Clawbit guides, troubleshoot common issues, review shortcuts,
            and open support actions without leaving the workspace.
          </p>
        </div>

        <div
          className={cn(
            "rounded-[16px] border px-4 py-3 text-[13px]",
            isDarkTheme
              ? "border-white/[0.04] bg-[color:var(--surface)] text-zinc-300"
              : "border-slate-300 bg-slate-50 text-slate-900",
          )}
        >
          {articles.length} {articles.length === 1 ? "article" : "articles"} available
        </div>
      </div>

      <div
        className={cn(
          "flex items-center gap-3 rounded-[14px] border px-4 py-3",
          isDarkTheme
            ? "border-white/[0.04] bg-[#11151b]"
            : "border-slate-300 bg-white",
        )}
      >
        <Search size={18} className={isDarkTheme ? "text-zinc-500" : "text-slate-400"} />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search docs, shortcuts, uploads, MCP, troubleshooting..."
          className={cn(
            "w-full bg-transparent text-[14px] outline-none placeholder:text-zinc-500",
            isDarkTheme ? "text-zinc-100" : "text-slate-950 placeholder:text-slate-500",
          )}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {quickActions.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={item.action}
            className="ui-button ui-button-secondary h-9 px-3 text-[12px] text-slate-950 dark:text-zinc-300"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-3">
          <p className={cn("text-[12px] font-semibold uppercase tracking-[0.2em]", isDarkTheme ? "text-zinc-500" : "text-slate-500")}>
            Documentation Library
          </p>
          {articles.length > 0 ? (
            <div className="space-y-2">
              {articles.map((article) => {
                const active = article.id === activeArticle?.id;

                return (
                  <button
                    key={article.id}
                    type="button"
                    onClick={() => onSelectArticle(article.id)}
                    className={cn(
                      "w-full rounded-[14px] border px-4 py-3 text-left transition",
                      active
                        ? "border-violet-500/20 bg-[color:var(--accent-hover)]"
                        : isDarkTheme
                          ? "border-white/[0.04] bg-[color:var(--surface)] hover:bg-white/[0.03]"
                          : "border-slate-300 bg-white hover:bg-slate-50",
                    )}
                  >
                    <p className={cn("text-[11px] font-semibold uppercase tracking-[0.18em]", active ? "text-violet-500" : isDarkTheme ? "text-zinc-500" : "text-slate-500")}>
                      {article.category}
                    </p>
                    <p className={cn("mt-1 text-[14px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
                      {article.title}
                    </p>
                    <p className={cn("mt-1 text-[12px] leading-5", isDarkTheme ? "text-zinc-400" : "text-slate-600")}>
                      {article.summary}
                    </p>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className={cn("rounded-[14px] border px-4 py-4 text-[13px]", isDarkTheme ? "border-white/[0.04] bg-[color:var(--surface)] text-zinc-400" : "border-slate-300 bg-white text-slate-600")}>
              No help articles matched your search.
            </div>
          )}
        </div>

        <div className="space-y-6">
          {activeArticle ? (
            <article
              className={cn(
                "rounded-[16px] border p-5",
                isDarkTheme
                  ? "border-white/[0.04] bg-[color:var(--surface)]"
                  : "border-slate-300 bg-white",
              )}
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-500">
                {activeArticle.category}
              </p>
              <h4 className={cn("mt-3 text-[22px] font-semibold tracking-tight", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
                {activeArticle.title}
              </h4>
              <p className={cn("mt-2 text-[14px] leading-7", isDarkTheme ? "text-zinc-400" : "text-slate-700")}>
                {activeArticle.summary}
              </p>

              <div className="mt-5 space-y-3">
                {activeArticle.content.map((paragraph) => (
                  <p key={paragraph} className={cn("text-[14px] leading-7", isDarkTheme ? "text-zinc-300" : "text-slate-700")}>
                    {paragraph}
                  </p>
                ))}
              </div>

              {activeArticle.steps ? (
                <div className="mt-6">
                  <p className={cn("text-[14px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
                    Setup steps
                  </p>
                  <ol className="mt-3 space-y-2">
                    {activeArticle.steps.map((step, index) => (
                      <li key={step} className={cn("flex gap-3 text-[13px] leading-6", isDarkTheme ? "text-zinc-300" : "text-slate-700")}>
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-hover)] text-[11px] font-semibold text-violet-500">
                          {index + 1}
                        </span>
                        {step}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {activeArticle.shortcuts ? (
                <div className="mt-6">
                  <p className={cn("text-[14px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
                    Keyboard shortcuts
                  </p>
                  <div className="mt-3 space-y-2">
                    {activeArticle.shortcuts.map((shortcut) => (
                      <div key={shortcut.keys} className={cn("flex items-center justify-between gap-4 rounded-[12px] border px-3 py-2 text-[13px]", isDarkTheme ? "border-white/[0.04] bg-white/[0.02] text-zinc-300" : "border-slate-300 bg-slate-50 text-slate-700")}>
                        <span>{shortcut.action}</span>
                        <kbd className={cn("rounded-md border px-2 py-1 text-[11px] font-semibold", isDarkTheme ? "border-white/[0.06] bg-black/20 text-zinc-100" : "border-slate-300 bg-white text-slate-900")}>
                          {shortcut.keys}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </article>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <HelpSummarySection
              title="Popular articles"
              items={popularArticles.map((article) => article.title)}
              theme={theme}
            />
            <HelpSummarySection
              title="Recent updates"
              items={releaseNotes?.content ?? []}
              theme={theme}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function HelpSummarySection({
  title,
  items,
  theme,
}: {
  title: string;
  items: string[];
  theme: Theme;
}) {
  const isDarkTheme = theme === "dark";

  return (
    <div
      className={cn(
        "rounded-[16px] border p-4",
        isDarkTheme
          ? "border-white/[0.04] bg-[color:var(--surface)]"
          : "border-slate-300 bg-white",
      )}
    >
      <p className={cn("text-[14px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
        {title}
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item} className={cn("text-[13px] leading-6", isDarkTheme ? "text-zinc-400" : "text-slate-700")}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CustomizeWorkspace({
  theme,
  state,
  status,
  onChange,
  onSave,
}: {
  theme: Theme;
  state: CustomizationState;
  status: string;
  onChange: (patch: Partial<CustomizationState>) => void;
  onSave: () => void;
}) {
  const isDarkTheme = theme === "dark";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-[color:var(--accent-hover)] text-violet-500">
            <Palette size={22} />
          </div>
          <h3
            className={cn(
              "mt-4 text-[20px] font-semibold tracking-tight",
              isDarkTheme ? "text-zinc-100" : "text-slate-950",
            )}
          >
            Customize
          </h3>
          <p
            className={cn(
              "mt-2 text-[15px] leading-7",
              isDarkTheme ? "text-zinc-400" : "text-slate-700",
            )}
          >
            Shape the assistant defaults used across new conversations. These
            preferences are saved locally for now.
          </p>
        </div>

        <div
          className={cn(
            "rounded-[16px] border px-4 py-3 text-[13px]",
            isDarkTheme
              ? "border-white/[0.04] bg-[color:var(--surface)] text-zinc-300"
              : "border-slate-300 bg-slate-50 text-slate-900",
          )}
        >
          {status}
        </div>
      </div>

      <SettingsGrid>
        <TextSetting
          label="Assistant Name"
          description="The name shown for the assistant in your workspace."
          value={state.assistantName}
          onChange={(value) => onChange({ assistantName: value })}
        />
        <SelectSetting
          label="Assistant Personality"
          description="Choose the default behavior style for replies."
          value={state.assistantPersonality}
          options={[
            "Helpful, precise, and collaborative",
            "Friendly and conversational",
            "Direct and concise",
            "Creative and exploratory",
            "Technical and analytical",
          ]}
          onChange={(value) => onChange({ assistantPersonality: value })}
        />
        <SegmentSetting
          label="Response Length"
          description="Set the default amount of detail in answers."
          value={state.responseLength}
          options={["Short", "Balanced", "Detailed"]}
          onChange={(value) => onChange({ responseLength: value })}
        />
        <SegmentSetting
          label="Response Tone"
          description="Control the default voice used in responses."
          value={state.responseTone}
          options={["Professional", "Casual", "Friendly", "Formal"]}
          onChange={(value) => onChange({ responseTone: value })}
        />
        <RangeSetting
          label="Temperature"
          description="Lower values are more focused; higher values are more creative."
          value={state.temperature}
          min={0}
          max={100}
          onChange={(value) => onChange({ temperature: value })}
        />
        <SwitchSetting
          label="Enable Memory"
          description="Allow the assistant to use saved preferences in future chats."
          checked={state.memoryEnabled}
          onChange={(checked) => onChange({ memoryEnabled: checked })}
        />
        <SelectSetting
          label="Default Model"
          description="Choose the preferred model for new conversations."
          value={state.defaultModel}
          options={[
            "Gemini 3.5 Flash",
            "Gemini 3.1 Flash-Lite",
            "Gemini 2.5 Pro",
            "GPT-4.1",
          ]}
          onChange={(value) => onChange({ defaultModel: value })}
        />
        <TextareaSetting
          label="Custom System Prompt"
          description="Add instructions that should guide the assistant's behavior."
          value={state.systemPrompt}
          onChange={(value) => onChange({ systemPrompt: value })}
        />
      </SettingsGrid>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onSave}
          className="ui-button ui-button-primary"
        >
          Save Customization
        </button>
      </div>
    </div>
  );
}

function PluginsWorkspace({
  theme,
  search,
  installedPlugins,
  availablePlugins,
  onSearchChange,
  onTogglePlugin,
}: {
  theme: Theme;
  search: string;
  installedPlugins: PluginEntry[];
  availablePlugins: PluginEntry[];
  onSearchChange: (value: string) => void;
  onTogglePlugin: (id: PluginId, enabled: boolean) => void;
}) {
  const isDarkTheme = theme === "dark";
  const enabledCount = installedPlugins.filter((plugin) => plugin.enabled).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-[color:var(--accent-hover)] text-violet-500">
            <PlugZap size={22} />
          </div>
          <h3
            className={cn(
              "mt-4 text-[20px] font-semibold tracking-tight",
              isDarkTheme ? "text-zinc-100" : "text-slate-950",
            )}
          >
            Plugins
          </h3>
          <p
            className={cn(
              "mt-2 text-[15px] leading-7",
              isDarkTheme ? "text-zinc-400" : "text-slate-700",
            )}
          >
            Connect approved tools, keep them organized, and control exactly
            which plugins are active in the workspace.
          </p>
        </div>
      </div>

      <div
        className={cn(
          "flex items-center gap-3 rounded-[14px] border px-4 py-3",
          isDarkTheme
            ? "border-white/[0.04] bg-[#11151b]"
            : "border-slate-300 bg-white",
        )}
      >
        <Search size={18} className={isDarkTheme ? "text-zinc-500" : "text-slate-400"} />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search plugins..."
          className={cn(
            "w-full bg-transparent text-[14px] outline-none placeholder:text-zinc-500",
            isDarkTheme ? "text-zinc-100" : "text-slate-950 placeholder:text-slate-500",
          )}
        />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <PluginPanel
          title="Installed plugins"
          count={installedPlugins.length}
          emptyLabel={
            search.trim()
              ? "No installed plugins matched your search."
              : "No plugins have been installed yet."
          }
          theme={theme}
        >
          <div className="space-y-3">
            {installedPlugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                theme={theme}
                onToggle={onTogglePlugin}
              />
            ))}
          </div>
        </PluginPanel>

        <PluginPanel
          title="Available plugins"
          count={availablePlugins.length}
          emptyLabel={
            search.trim()
              ? "No available plugins matched your search."
              : "Everything in the catalog is already active."
          }
          theme={theme}
        >
          <div className="space-y-3">
            {availablePlugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                theme={theme}
                onToggle={onTogglePlugin}
              />
            ))}
          </div>
        </PluginPanel>
      </div>

      <div
        className={cn(
          "flex flex-col gap-4 rounded-[14px] border px-4 py-3 text-[13px] sm:flex-row sm:items-center sm:justify-between",
          isDarkTheme
            ? "border-white/[0.04] bg-[color:var(--surface)] text-zinc-300"
            : "border-slate-300 bg-slate-50 text-slate-900",
        )}
      >
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-500">
          Workspace status
        </p>
        <div className="flex gap-6">
          <div>
            <p className={cn("text-[12px]", isDarkTheme ? "text-zinc-400" : "text-slate-600")}>Installed</p>
            <p className={cn("text-[18px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
              {installedPlugins.length}
            </p>
          </div>
          <div>
            <p className={cn("text-[12px]", isDarkTheme ? "text-zinc-400" : "text-slate-600")}>Enabled</p>
            <p className={cn("text-[18px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
              {enabledCount}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function PluginPanel({
  title,
  count,
  emptyLabel,
  theme,
  children,
}: {
  title: string;
  count: number;
  emptyLabel: string;
  theme: Theme;
  children: React.ReactNode;
}) {
  const isDarkTheme = theme === "dark";

  return (
    <div
      className={cn(
        "min-w-0",
        isDarkTheme
          ? "text-zinc-100"
          : "text-slate-950",
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b pb-3 dark:border-white/[0.04]">
        <div>
          <p className={cn("text-[15px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
            {title}
          </p>
          <p className={cn("mt-1 text-[12px]", isDarkTheme ? "text-zinc-400" : "text-slate-600")}>
            {count} {count === 1 ? "plugin" : "plugins"}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {count > 0 ? (
          children
        ) : (
          <div
            className={cn(
              "rounded-[14px] border px-4 py-4 text-[13px] leading-6",
              isDarkTheme
                ? "border-white/[0.04] bg-white/[0.02] text-zinc-400"
                : "border-slate-300 bg-slate-50 text-slate-600",
            )}
          >
            {emptyLabel}
          </div>
        )}
      </div>
    </div>
  );
}

function PluginCard({
  plugin,
  theme,
  onToggle,
}: {
  plugin: PluginEntry;
  theme: Theme;
  onToggle: (id: PluginId, enabled: boolean) => void;
}) {
  const isDarkTheme = theme === "dark";
  const statusLabel = plugin.installed
    ? plugin.enabled
      ? "Enabled"
      : "Disabled"
    : "Available";

  return (
    <div
      className={cn(
        "rounded-[14px] border p-4 shadow-none",
        isDarkTheme
          ? "border-white/[0.04] bg-[#11151b]"
          : "border-slate-300 bg-[color:var(--panel)]",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className={cn("truncate text-[15px] font-semibold", isDarkTheme ? "text-zinc-100" : "text-slate-950")}>
              {plugin.name}
            </p>
            <span
              className={cn(
                "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]",
                plugin.installed
                  ? isDarkTheme
                    ? "bg-white/[0.06] text-zinc-100"
                    : "bg-slate-200 text-slate-700"
                  : "bg-violet-500/12 text-violet-400",
              )}
            >
              {statusLabel}
            </span>
          </div>
          <p
            className={cn(
              "mt-2 text-[13px] leading-6",
              isDarkTheme ? "text-zinc-400" : "text-slate-600",
            )}
          >
            {plugin.description}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <span
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                isDarkTheme
                  ? "border-white/[0.05] bg-white/[0.02] text-zinc-300"
                  : "border-slate-300 bg-white text-slate-700",
              )}
            >
              {plugin.category}
            </span>
            <span
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                isDarkTheme
                  ? "border-white/[0.05] bg-white/[0.02] text-zinc-300"
                  : "border-slate-300 bg-white text-slate-700",
              )}
            >
              {plugin.source}
            </span>
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={plugin.installed ? plugin.enabled : false}
          aria-label={`${plugin.name} ${plugin.installed ? (plugin.enabled ? "enabled" : "disabled") : "available"}`}
          onClick={() => onToggle(plugin.id, !plugin.enabled)}
          className={cn(
            "flex h-11 w-14 shrink-0 items-center rounded-full border p-1 transition",
            plugin.installed && plugin.enabled
              ? "border-violet-500/30 bg-violet-500"
              : isDarkTheme
                ? "border-white/[0.05] bg-white/[0.03]"
                : "border-slate-300 bg-slate-200",
          )}
        >
          <span
            className={cn(
              "h-4 w-4 rounded-full bg-white transition",
              plugin.installed && plugin.enabled ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </div>
  );
}
