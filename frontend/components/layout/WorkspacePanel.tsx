"use client";

import {
  Check,
  CircleHelp,
  Clipboard,
  Info,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Telescope,
  UserRound,
  X,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

import MCPConnectorsPanel from "@/components/projects/MCPConnectorsPanel";
import SettingsWorkspace from "@/components/settings/SettingsWorkspace";

import {
  getActiveChatMode,
  setActiveChatMode,
  type ChatMode,
} from "@/lib/api";

import type { RouteView } from "@/lib/navigation";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

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
    | "created"
    | "shared";

  createdAt: number;
  updatedAt: number;

  conversations:
    ProjectConversation[];

  files:
    ProjectFile[];
}

interface WorkspacePanelProps {
  view: RouteView;
  theme: Theme;

  projects: ProjectRecord[];

  activeProjectId:
    string | null;

  onExitSettings:
    () => void;

  onCreateProject:
    (name: string) => void;

  onRenameProject: (
    id: string,
    name: string,
  ) => void;

  onDeleteProject: (
    id: string,
  ) => void;

  onOpenProject: (
    id: string,
  ) => void;
}

interface ProfileState {
  name: string;

  workspaceName:
    string;

  bio: string;
}

interface PersonalizationState {
  assistantName:
    string;

  responseTone:
    | "Balanced"
    | "Friendly"
    | "Professional"
    | "Direct";

  responseLength:
    | "Short"
    | "Balanced"
    | "Detailed";

  customInstructions:
    string;

  defaultMode:
    ChatMode;
}

interface HelpArticle {
  id: string;
  category: string;
  title: string;
  summary: string;
  body: string[];
  steps?: string[];
}

/* ====================================================== */
/* STORAGE                                                */
/* ====================================================== */

const PROFILE_STORAGE_KEY =
  "clawbit.profile.v1";

const PERSONALIZATION_STORAGE_KEY =
  "clawbit.customization.state.v1";

/* ====================================================== */
/* DEFAULTS                                               */
/* ====================================================== */

const defaultProfile:
  ProfileState = {
    name:
      "Hassan Kadri",

    workspaceName:
      "Personal workspace",

    bio:
      "",
  };

const defaultPersonalization:
  PersonalizationState = {
    assistantName:
      "Clawbit",

    responseTone:
      "Balanced",

    responseLength:
      "Balanced",

    customInstructions:
      "",

    defaultMode:
      "normal",
  };

/* ====================================================== */
/* HELP DATA                                              */
/* ====================================================== */

const helpArticles:
  HelpArticle[] = [
    {
      id:
        "getting-started",

      category:
        "Getting started",

      title:
        "Start using Clawbit",

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
      id:
        "projects",

      category:
        "Projects",

      title:
        "Projects and project history",

      summary:
        "Keep related conversations and files together.",

      body: [
        "A project keeps its own conversation history and uploaded file information.",

        "Opening an existing project can restore its most recent conversation.",

        "Use project history when you want to return to an older conversation inside that project.",
      ],
    },

    {
      id:
        "research",

      category:
        "Research",

      title:
        "Research mode",

      summary:
        "Use deeper web research when a question needs current or verified information.",

      body: [
        "Switch to Research mode from the chat mode controls.",

        "Research mode is intended for questions that benefit from multiple searches or source checking.",

        "You can return to Normal mode whenever deeper research is not needed.",
      ],
    },

    {
      id:
        "mcp",

      category:
        "Tools & MCP",

      title:
        "Connect external tools",

      summary:
        "Connect supported services such as GitHub, Notion, Stripe, Google Drive, and Slack.",

      body: [
        "Open Tools to manage MCP connectors.",

        "Token-based connectors ask for credentials in the connector dialog. Google Drive and Slack use OAuth.",

        "Connected MCP tools can then be made available to Clawbit when they are relevant to a conversation.",
      ],
    },

    {
      id:
        "files",

      category:
        "Files",

      title:
        "Upload and use files",

      summary:
        "Attach documents and images so Clawbit can work with them.",

      body: [
        "Use the + button in the composer to select files.",

        "Wait for an upload to finish before sending when you want the answer to use that file.",

        "Files uploaded inside Projects can also appear in the project's Files section.",
      ],
    },

    {
      id:
        "troubleshooting",

      category:
        "Troubleshooting",

      title:
        "Fix common local-development issues",

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
      id:
        "shortcuts",

      category:
        "Keyboard",

      title:
        "Keyboard shortcuts",

      summary:
        "Move around Clawbit faster.",

      body: [
        "Ctrl/Cmd + K opens the command palette.",

        "Enter sends a message from the composer.",

        "Shift + Enter inserts a new line.",

        "Escape closes most menus and dialogs.",
      ],
    },
  ];

/* ====================================================== */
/* STORAGE HELPER                                         */
/* ====================================================== */

function readStoredObject<T>(
  key: string,
  fallback: T,
): T {
  if (
    typeof window ===
    "undefined"
  ) {
    return fallback;
  }

  try {
    const raw =
      window.localStorage.getItem(
        key,
      );

    if (
      !raw
    ) {
      return fallback;
    }

    const parsed =
      JSON.parse(
        raw,
      ) as Partial<T>;

    return {
      ...fallback,
      ...parsed,
    };
  } catch {
    return fallback;
  }
}

/* ====================================================== */
/* SHARED UI                                              */
/* ====================================================== */

function FieldLabel({
  children,
}: {
  children:
    ReactNode;
}) {
  return (
    <span className="mb-2 block text-[11px] font-medium text-[color:var(--muted-foreground)]">
      {children}
    </span>
  );
}

function PageHeader({
  icon: Icon,
  title,
  description,
}: {
  icon:
    ComponentType<{
      size?: number;
      className?: string;
    }>;

  title:
    string;

  description:
    string;
}) {
  return (
    <div className="mb-7 flex items-start gap-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] border border-[color:var(--border)] bg-[color:var(--surface)]">
        <Icon
          size={
            19
          }
          className="text-[color:var(--foreground)]"
        />
      </div>

      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-[color:var(--foreground)]">
          {
            title
          }
        </h1>

        <p className="mt-1.5 max-w-2xl text-[12px] leading-5 text-[color:var(--muted-foreground)]">
          {
            description
          }
        </p>
      </div>
    </div>
  );
}

function Card({
  children,
  className,
}: {
  children:
    ReactNode;

  className?:
    string;
}) {
  return (
    <div
      className={cn(
        "rounded-[18px] border border-[color:var(--border)] bg-[color:var(--surface)] p-5 text-[color:var(--foreground)]",

        className,
      )}
    >
      {
        children
      }
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value:
    string;

  onChange:
    (value: string) => void;

  placeholder?:
    string;
}) {
  return (
    <input
      value={
        value
      }
      onChange={(
        event,
      ) =>
        onChange(
          event.target
            .value,
        )
      }
      placeholder={
        placeholder
      }
      className="h-10 w-full rounded-[11px] border border-[color:var(--border)] bg-[color:var(--background)] px-3 text-[12px] text-[color:var(--foreground)] outline-none shadow-none placeholder:text-[color:var(--muted-foreground)] focus:border-[color:var(--border-strong)] focus:outline-none focus:ring-0"
    />
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled = false,
}: {
  children:
    ReactNode;

  onClick:
    () => void;

  disabled?:
    boolean;
}) {
  return (
    <button
      type="button"
      disabled={
        disabled
      }
      onClick={
        onClick
      }
      className="inline-flex h-9 items-center justify-center gap-2 rounded-[10px] bg-[color:var(--accent)] px-4 text-[12px] font-medium text-[color:var(--accent-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {
        children
      }
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
  danger = false,
}: {
  children:
    ReactNode;

  onClick:
    () => void;

  danger?:
    boolean;
}) {
  return (
    <button
      type="button"
      onClick={
        onClick
      }
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-[10px] border px-4 text-[12px] transition-colors",

        danger
          ? "border-red-500/20 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/[0.08]"
          : "border-[color:var(--border)] text-[color:var(--foreground)] hover:bg-[color:var(--accent-hover)]",
      )}
    >
      {
        children
      }
    </button>
  );
}

function SelectionButton({
  selected,
  children,
  onClick,
}: {
  selected:
    boolean;

  children:
    ReactNode;

  onClick:
    () => void;
}) {
  return (
    <button
      type="button"
      onClick={
        onClick
      }
      className={cn(
        "flex min-h-9 items-center justify-center gap-2 rounded-[10px] border px-3 text-[11px] transition-colors",

        selected
          ? "border-[color:var(--border-strong)] bg-[color:var(--surface-alt)] text-[color:var(--foreground)]"
          : "border-[color:var(--border)] bg-[color:var(--background)] text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]",
      )}
    >
      {
        children
      }
    </button>
  );
}

/* ====================================================== */
/* PROFILE                                                */
/* ====================================================== */

function ProfileWorkspace() {
  const [
    profile,
    setProfile,
  ] =
    useState<ProfileState>(
      defaultProfile,
    );

  const [
    savedProfile,
    setSavedProfile,
  ] =
    useState<ProfileState>(
      defaultProfile,
    );

  useEffect(() => {
    const stored =
      readStoredObject(
        PROFILE_STORAGE_KEY,
        defaultProfile,
      );

    const frameId =
      window.requestAnimationFrame(
        () => {
          setProfile(
            stored,
          );

          setSavedProfile(
            stored,
          );
        },
      );

    return () => {
      window.cancelAnimationFrame(
        frameId,
      );
    };
  }, []);

  const dirty =
    JSON.stringify(
      profile,
    ) !==
    JSON.stringify(
      savedProfile,
    );

  function saveProfile() {
    const nextProfile:
      ProfileState = {
        name:
          profile.name.trim() ||
          defaultProfile.name,

        workspaceName:
          profile.workspaceName.trim() ||
          defaultProfile.workspaceName,

        bio:
          profile.bio.trim(),
      };

    window.localStorage.setItem(
      PROFILE_STORAGE_KEY,
      JSON.stringify(
        nextProfile,
      ),
    );

    setProfile(
      nextProfile,
    );

    setSavedProfile(
      nextProfile,
    );

    window.dispatchEvent(
      new CustomEvent(
        "clawbit:profile-updated",
        {
          detail:
            nextProfile,
        },
      ),
    );
  }

  function resetProfile() {
    setProfile(
      defaultProfile,
    );

    setSavedProfile(
      defaultProfile,
    );

    window.localStorage.setItem(
      PROFILE_STORAGE_KEY,
      JSON.stringify(
        defaultProfile,
      ),
    );

    window.dispatchEvent(
      new CustomEvent(
        "clawbit:profile-updated",
        {
          detail:
            defaultProfile,
        },
      ),
    );
  }

  const initials =
    profile.name
      .split(
        /\s+/,
      )
      .filter(
        Boolean,
      )
      .slice(
        0,
        2,
      )
      .map(
        (
          part,
        ) =>
          part[0]
            ?.toUpperCase(),
      )
      .join(
        "",
      ) ||
    "U";

  return (
    <>
      <PageHeader
        icon={
          UserRound
        }
        title="Profile"
        description="Edit the identity shown in your local Clawbit workspace. These details are stored in this browser."
      />

      <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
        <Card className="h-fit text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-[color:var(--border)] bg-[color:var(--surface-alt)] text-[17px] font-semibold text-[color:var(--foreground)]">
            {
              initials
            }
          </div>

          <p className="mt-4 truncate text-[14px] font-medium text-[color:var(--foreground)]">
            {profile.name ||
              "Your name"}
          </p>

          <p className="mt-1 truncate text-[10px] text-[color:var(--muted-foreground)]">
            {profile.workspaceName ||
              "Personal workspace"}
          </p>
        </Card>

        <Card>
          <div className="grid gap-5 sm:grid-cols-2">
            <label>
              <FieldLabel>
                Display name
              </FieldLabel>

              <TextInput
                value={
                  profile.name
                }
                placeholder="Your name"
                onChange={(
                  value,
                ) =>
                  setProfile(
                    (
                      current,
                    ) => ({
                      ...current,

                      name:
                        value,
                    }),
                  )
                }
              />
            </label>

            <label>
              <FieldLabel>
                Workspace label
              </FieldLabel>

              <TextInput
                value={
                  profile.workspaceName
                }
                placeholder="Personal workspace"
                onChange={(
                  value,
                ) =>
                  setProfile(
                    (
                      current,
                    ) => ({
                      ...current,

                      workspaceName:
                        value,
                    }),
                  )
                }
              />
            </label>
          </div>

          <label className="mt-5 block">
            <FieldLabel>
              About you
            </FieldLabel>

            <textarea
              value={
                profile.bio
              }
              onChange={(
                event,
              ) =>
                setProfile(
                  (
                    current,
                  ) => ({
                    ...current,

                    bio:
                      event.target
                        .value,
                  }),
                )
              }
              rows={
                4
              }
              maxLength={
                280
              }
              placeholder="A short description for this local workspace."
              className="w-full resize-none rounded-[12px] border border-[color:var(--border)] bg-[color:var(--background)] px-3 py-3 text-[12px] leading-5 text-[color:var(--foreground)] outline-none shadow-none placeholder:text-[color:var(--muted-foreground)] focus:border-[color:var(--border-strong)] focus:outline-none focus:ring-0"
            />

            <p className="mt-1 text-right text-[9px] text-[color:var(--muted-foreground)]">
              {
                profile.bio
                  .length
              }
              /280
            </p>
          </label>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <PrimaryButton
              onClick={
                saveProfile
              }
              disabled={
                !dirty
              }
            >
              <Save
                size={
                  14
                }
              />

              Save profile
            </PrimaryButton>

            <SecondaryButton
              onClick={
                resetProfile
              }
            >
              <RotateCcw
                size={
                  14
                }
              />

              Reset
            </SecondaryButton>
          </div>
        </Card>
      </div>
    </>
  );
}

/* ====================================================== */
/* PERSONALIZATION                                        */
/* ====================================================== */

function PersonalizationWorkspace() {
  const [
    state,
    setState,
  ] =
    useState<PersonalizationState>(
      defaultPersonalization,
    );

  const [
    savedState,
    setSavedState,
  ] =
    useState<PersonalizationState>(
      defaultPersonalization,
    );

  useEffect(() => {
    const stored =
      readStoredObject<
        Record<
          string,
          unknown
        >
      >(
        PERSONALIZATION_STORAGE_KEY,
        {},
      );

    const restored:
      PersonalizationState = {
        assistantName:
          typeof stored.assistantName ===
          "string"
            ? stored.assistantName
            : defaultPersonalization.assistantName,

        responseTone:
          stored.responseTone ===
            "Friendly" ||
          stored.responseTone ===
            "Professional" ||
          stored.responseTone ===
            "Direct" ||
          stored.responseTone ===
            "Balanced"
            ? stored.responseTone
            : defaultPersonalization.responseTone,

        responseLength:
          stored.responseLength ===
            "Short" ||
          stored.responseLength ===
            "Detailed" ||
          stored.responseLength ===
            "Balanced"
            ? stored.responseLength
            : defaultPersonalization.responseLength,

        customInstructions:
          typeof stored.customInstructions ===
          "string"
            ? stored.customInstructions
            : typeof stored.systemPrompt ===
                "string"
              ? stored.systemPrompt
              : "",

        defaultMode:
          getActiveChatMode(),
      };

    const frameId =
      window.requestAnimationFrame(
        () => {
          setState(
            restored,
          );

          setSavedState(
            restored,
          );
        },
      );

    return () => {
      window.cancelAnimationFrame(
        frameId,
      );
    };
  }, []);

  const dirty =
    JSON.stringify(
      state,
    ) !==
    JSON.stringify(
      savedState,
    );

  function savePersonalization() {
    const nextState:
      PersonalizationState = {
        ...state,

        assistantName:
          state.assistantName.trim() ||
          defaultPersonalization.assistantName,

        customInstructions:
          state.customInstructions.trim(),
      };

    window.localStorage.setItem(
      PERSONALIZATION_STORAGE_KEY,
      JSON.stringify(
        nextState,
      ),
    );

    setActiveChatMode(
      nextState.defaultMode,
    );

    setState(
      nextState,
    );

    setSavedState(
      nextState,
    );

    window.dispatchEvent(
      new CustomEvent(
        "clawbit:personalization-updated",
        {
          detail:
            nextState,
        },
      ),
    );
  }

  function resetPersonalization() {
    const reset:
      PersonalizationState = {
        ...defaultPersonalization,

        defaultMode:
          "normal",
      };

    setState(
      reset,
    );

    setSavedState(
      reset,
    );

    setActiveChatMode(
      "normal",
    );

    window.localStorage.setItem(
      PERSONALIZATION_STORAGE_KEY,
      JSON.stringify(
        reset,
      ),
    );

    window.dispatchEvent(
      new CustomEvent(
        "clawbit:personalization-updated",
        {
          detail:
            reset,
        },
      ),
    );
  }

  return (
    <>
      <PageHeader
        icon={
          SlidersHorizontal
        }
        title="Personalization"
        description="Choose your default chat mode and save response preferences for this local Clawbit workspace."
      />

      <div className="space-y-4">
        <Card>
          <div className="grid gap-5 md:grid-cols-2">
            <label>
              <FieldLabel>
                Assistant name
              </FieldLabel>

              <TextInput
                value={
                  state.assistantName
                }
                onChange={(
                  value,
                ) =>
                  setState(
                    (
                      current,
                    ) => ({
                      ...current,

                      assistantName:
                        value,
                    }),
                  )
                }
              />
            </label>

            <div>
              <FieldLabel>
                Default chat mode
              </FieldLabel>

              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    "normal",
                    "research",
                  ] as ChatMode[]
                ).map(
                  (
                    mode,
                  ) => (
                    <SelectionButton
                      key={
                        mode
                      }
                      selected={
                        state.defaultMode ===
                        mode
                      }
                      onClick={() =>
                        setState(
                          (
                            current,
                          ) => ({
                            ...current,

                            defaultMode:
                              mode,
                          }),
                        )
                      }
                    >
                      {mode ===
                      "research" ? (
                        <Telescope
                          size={
                            13
                          }
                        />
                      ) : null}

                      <span className="capitalize">
                        {
                          mode
                        }
                      </span>

                      {state.defaultMode ===
                      mode ? (
                        <Check
                          size={
                            13
                          }
                        />
                      ) : null}
                    </SelectionButton>
                  ),
                )}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <FieldLabel>
                Response tone
              </FieldLabel>

              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    "Balanced",
                    "Friendly",
                    "Professional",
                    "Direct",
                  ] as const
                ).map(
                  (
                    tone,
                  ) => (
                    <SelectionButton
                      key={
                        tone
                      }
                      selected={
                        state.responseTone ===
                        tone
                      }
                      onClick={() =>
                        setState(
                          (
                            current,
                          ) => ({
                            ...current,

                            responseTone:
                              tone,
                          }),
                        )
                      }
                    >
                      {
                        tone
                      }
                    </SelectionButton>
                  ),
                )}
              </div>
            </div>

            <div>
              <FieldLabel>
                Response length
              </FieldLabel>

              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    "Short",
                    "Balanced",
                    "Detailed",
                  ] as const
                ).map(
                  (
                    length,
                  ) => (
                    <SelectionButton
                      key={
                        length
                      }
                      selected={
                        state.responseLength ===
                        length
                      }
                      onClick={() =>
                        setState(
                          (
                            current,
                          ) => ({
                            ...current,

                            responseLength:
                              length,
                          }),
                        )
                      }
                    >
                      {
                        length
                      }
                    </SelectionButton>
                  ),
                )}
              </div>
            </div>
          </div>

          <label className="mt-5 block">
            <FieldLabel>
              Custom instructions
            </FieldLabel>

            <textarea
              value={
                state.customInstructions
              }
              onChange={(
                event,
              ) =>
                setState(
                  (
                    current,
                  ) => ({
                    ...current,

                    customInstructions:
                      event.target
                        .value,
                  }),
                )
              }
              rows={
                5
              }
              placeholder="Example: Use simple English and keep coding explanations beginner-friendly."
              className="w-full resize-none rounded-[12px] border border-[color:var(--border)] bg-[color:var(--background)] px-3 py-3 text-[12px] leading-5 text-[color:var(--foreground)] outline-none shadow-none placeholder:text-[color:var(--muted-foreground)] focus:border-[color:var(--border-strong)] focus:outline-none focus:ring-0"
            />
          </label>

          <div className="mt-3 flex items-start gap-2 rounded-[11px] border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5 text-[10px] leading-4 text-[color:var(--muted-foreground)]">
            <Info
              size={
                13
              }
              className="mt-0.5 shrink-0 text-amber-500"
            />

            <p>
              Assistant name,
              tone, response
              length, and custom
              instructions are
              saved locally.
              Normal / Research
              mode is applied
              immediately.
            </p>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <PrimaryButton
              onClick={
                savePersonalization
              }
              disabled={
                !dirty
              }
            >
              <Save
                size={
                  14
                }
              />

              Save changes
            </PrimaryButton>

            <SecondaryButton
              onClick={
                resetPersonalization
              }
            >
              <RotateCcw
                size={
                  14
                }
              />

              Reset
            </SecondaryButton>
          </div>
        </Card>
      </div>
    </>
  );
}

/* ====================================================== */
/* HELP                                                   */
/* ====================================================== */

function HelpWorkspace() {
  const [
    search,
    setSearch,
  ] =
    useState(
      "",
    );

  const [
    selectedId,
    setSelectedId,
  ] =
    useState(
      helpArticles[0]
        .id,
    );

  const [
    copyStatus,
    setCopyStatus,
  ] =
    useState<
      string | null
    >(
      null,
    );

  const filtered =
    useMemo(
      () => {
        const query =
          search
            .trim()
            .toLowerCase();

        if (
          !query
        ) {
          return helpArticles;
        }

        return helpArticles.filter(
          (
            article,
          ) =>
            [
              article.category,
              article.title,
              article.summary,
              ...article.body,

              ...(
                article.steps ??
                []
              ),
            ]
              .join(
                " ",
              )
              .toLowerCase()
              .includes(
                query,
              ),
        );
      },
      [
        search,
      ],
    );

  const activeArticle =
    filtered.find(
      (
        article,
      ) =>
        article.id ===
        selectedId,
    ) ??
    filtered[
      0
    ] ??
    null;

  async function copyDiagnostics() {
    const lines = [
      "Clawbit diagnostics",

      `URL: ${window.location.href}`,

      `Browser: ${navigator.userAgent}`,

      `Time: ${new Date().toISOString()}`,

      `Theme: ${
        document.documentElement.classList.contains(
          "dark",
        )
          ? "dark"
          : "light"
      }`,

      `Chat mode: ${getActiveChatMode()}`,
    ];

    try {
      await navigator.clipboard.writeText(
        lines.join(
          "\n",
        ),
      );

      setCopyStatus(
        "Diagnostics copied.",
      );
    } catch {
      setCopyStatus(
        "Clipboard access was blocked.",
      );
    }
  }

  return (
    <>
      <PageHeader
        icon={
          CircleHelp
        }
        title="Help & Docs"
        description="Search Clawbit help for chats, Projects, Research mode, files, MCP, and keyboard shortcuts."
      />

      {/* SEARCH */}

      <div className="relative mb-5 max-w-[620px]">
        <Search
          size={
            14
          }
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--muted-foreground)]"
        />

        <input
          value={
            search
          }
          onChange={(
            event,
          ) =>
            setSearch(
              event.target
                .value,
            )
          }
          placeholder="Search Help & Docs"
          className="h-10 w-full rounded-[11px] border border-[color:var(--border)] bg-[color:var(--surface)] pl-9 pr-9 text-[12px] text-[color:var(--foreground)] outline-none shadow-none placeholder:text-[color:var(--muted-foreground)] focus:border-[color:var(--border-strong)] focus:outline-none focus:ring-0"
        />

        {search ? (
          <button
            type="button"
            onClick={() =>
              setSearch(
                "",
              )
            }
            aria-label="Clear help search"
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]"
          >
            <X
              size={
                11
              }
            />
          </button>
        ) : null}
      </div>

      <div className="grid min-h-[430px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* ARTICLE LIST */}

        <Card className="h-fit p-2">
          {filtered.length >
          0 ? (
            filtered.map(
              (
                article,
              ) => {
                const active =
                  activeArticle?.id ===
                  article.id;

                return (
                  <button
                    key={
                      article.id
                    }
                    type="button"
                    onClick={() =>
                      setSelectedId(
                        article.id,
                      )
                    }
                    className={cn(
                      "w-full rounded-[11px] px-3 py-3 text-left transition-colors",

                      active
                        ? "bg-[color:var(--surface-alt)]"
                        : "hover:bg-[color:var(--accent-hover)]",
                    )}
                  >
                    <p className="text-[9px] uppercase tracking-[0.16em] text-[color:var(--muted-foreground)]">
                      {
                        article.category
                      }
                    </p>

                    <p className="mt-1 text-[11px] font-medium text-[color:var(--foreground)]">
                      {
                        article.title
                      }
                    </p>
                  </button>
                );
              },
            )
          ) : (
            <p className="px-3 py-8 text-center text-[11px] text-[color:var(--muted-foreground)]">
              No help article
              matched your search.
            </p>
          )}
        </Card>

        {/* ARTICLE */}

        <Card>
          {activeArticle ? (
            <article>
              <p className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted-foreground)]">
                {
                  activeArticle.category
                }
              </p>

              <h2 className="mt-2 text-[18px] font-semibold tracking-[-0.02em] text-[color:var(--foreground)]">
                {
                  activeArticle.title
                }
              </h2>

              <p className="mt-2 text-[11px] leading-5 text-[color:var(--muted-foreground)]">
                {
                  activeArticle.summary
                }
              </p>

              <div className="mt-5 space-y-3">
                {activeArticle.body.map(
                  (
                    paragraph,
                  ) => (
                    <p
                      key={
                        paragraph
                      }
                      className="text-[12px] leading-6 text-[color:var(--foreground)]"
                    >
                      {
                        paragraph
                      }
                    </p>
                  ),
                )}
              </div>

              {activeArticle.steps
                ?.length ? (
                <div className="mt-6 border-t border-[color:var(--border)] pt-5">
                  <p className="text-[11px] font-medium text-[color:var(--foreground)]">
                    Steps
                  </p>

                  <ol className="mt-3 space-y-2">
                    {activeArticle.steps.map(
                      (
                        step,
                        index,
                      ) => (
                        <li
                          key={
                            step
                          }
                          className="flex gap-3 text-[11px] leading-5 text-[color:var(--muted-foreground)]"
                        >
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--surface-alt)] text-[9px] text-[color:var(--foreground)]">
                            {
                              index +
                              1
                            }
                          </span>

                          <span>
                            {
                              step
                            }
                          </span>
                        </li>
                      ),
                    )}
                  </ol>
                </div>
              ) : null}
            </article>
          ) : (
            <div className="flex min-h-[300px] items-center justify-center text-[11px] text-[color:var(--muted-foreground)]">
              Choose a help
              article.
            </div>
          )}
        </Card>
      </div>

      {/* DIAGNOSTICS */}

      <Card className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <Clipboard
            size={
              15
            }
            className="mt-0.5 text-[color:var(--muted-foreground)]"
          />

          <div>
            <p className="text-[11px] font-medium text-[color:var(--foreground)]">
              Need debugging
              information?
            </p>

            <p className="mt-1 text-[10px] text-[color:var(--muted-foreground)]">
              Copy non-secret
              browser diagnostics
              for a bug report.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {copyStatus ? (
            <span className="text-[10px] text-[color:var(--muted-foreground)]">
              {
                copyStatus
              }
            </span>
          ) : null}

          <SecondaryButton
            onClick={() =>
              void copyDiagnostics()
            }
          >
            <Clipboard
              size={
                14
              }
            />

            Copy diagnostics
          </SecondaryButton>
        </div>
      </Card>
    </>
  );
}

/* ====================================================== */
/* MAIN                                                   */
/* ====================================================== */

export default function WorkspacePanel({
  view,
  theme,
  onExitSettings,
}: WorkspacePanelProps) {
  const pageClass =
    "mx-auto h-full min-h-0 w-full max-w-[1050px] overflow-y-auto px-5 pb-12 pt-7 lg:px-8 lg:pt-9";

  /* ==================================================== */
  /* MCP TOOLS                                            */
  /* ==================================================== */

  if (
    view ===
    "plugins"
  ) {
    return (
      <MCPConnectorsPanel
        theme={
          theme
        }
        open={
          true
        }
        onOpenChange={(
          open,
        ) => {
          if (
            !open
          ) {
            onExitSettings();
          }
        }}
      />
    );
  }

  /* ==================================================== */
  /* PROFILE                                              */
  /* ==================================================== */

  if (
    view ===
    "profile"
  ) {
    return (
      <div className={pageClass}>
        <ProfileWorkspace />
      </div>
    );
  }

  /* ==================================================== */
  /* PERSONALIZATION                                      */
  /* ==================================================== */

  if (
    view ===
    "customize"
  ) {
    return (
      <div className={pageClass}>
        <PersonalizationWorkspace />
      </div>
    );
  }

  /* ==================================================== */
  /* SETTINGS                                             */
  /* ==================================================== */

  if (
    view ===
    "settings"
  ) {
    return (
      <SettingsWorkspace
        onExitSettings={
          onExitSettings
        }
      />
    );
  }

  /* ==================================================== */
  /* HELP                                                 */
  /* ==================================================== */

  if (
    view ===
    "help"
  ) {
    return (
      <div className={pageClass}>
        <HelpWorkspace />
      </div>
    );
  }

  return null;
}