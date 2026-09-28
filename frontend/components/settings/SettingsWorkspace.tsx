"use client";

import {
  Bell,
  Check,
  Database,
  Download,
  HardDrive,
  Import,
  Laptop,
  MessageSquare,
  Moon,
  Palette,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Sun,
  Trash2,
  X,
} from "lucide-react";

import { useTheme } from "next-themes";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { setActiveChatMode } from "@/lib/api";
import { MODELS } from "@/lib/models";

import {
  DEFAULT_APP_SETTINGS,
  readAppSettings,
  writeAppSettings,
  type AppSettings,
} from "@/lib/settings";

import { cn } from "@/lib/utils";

/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

interface SettingsWorkspaceProps {
  onExitSettings: () => void;
}

type ThemeMode =
  | "system"
  | "dark"
  | "light";

type ChatMode =
  | "normal"
  | "research";

/* ====================================================== */
/* CONSTANTS                                              */
/* ====================================================== */

const CHAT_STORAGE_KEYS = [
  "clawbit.conversations.v1",
  "clawbit.conversations.active.v1",
];

const PROJECT_STORAGE_KEYS = [
  "clawbit.projects.v1",
  "clawbit.projects.active.v1",
];

const PERSONALIZATION_STORAGE_KEYS = [
  "clawbit.customization.state.v1",
  "clawbit.profile.v1",
];

const availableModels =
  MODELS.filter(
    (model) =>
      model.available,
  );

/* ====================================================== */
/* MAIN                                                   */
/* ====================================================== */

export default function SettingsWorkspace({
  onExitSettings,
}: SettingsWorkspaceProps) {
  const {
    setTheme,
  } = useTheme();

  const [
    settings,
    setSettings,
  ] =
    useState<AppSettings>(
      DEFAULT_APP_SETTINGS,
    );

  const [
    storageSize,
    setStorageSize,
  ] =
    useState(
      "Calculating...",
    );

  const [
    status,
    setStatus,
  ] =
    useState<
      string | null
    >(
      null,
    );

  const importInputRef =
    useRef<HTMLInputElement | null>(
      null,
    );

  /* ==================================================== */
  /* LOAD                                                 */
  /* ==================================================== */

  useEffect(() => {
    const frameId =
      window.requestAnimationFrame(
        () => {
          setSettings(
            readAppSettings(),
          );

          void refreshStorageSize();
        },
      );

    return () => {
      window.cancelAnimationFrame(
        frameId,
      );
    };
  }, []);

  /* ==================================================== */
  /* SETTINGS                                             */
  /* ==================================================== */

  function updateSettings(
    patch:
      Partial<AppSettings>,
  ) {
    writeAppSettings(
      patch,
    );

    setSettings(
      readAppSettings(),
    );
  }

  function selectTheme(
    mode:
      ThemeMode,
  ) {
    setTheme(
      mode,
    );

    updateSettings({
      themeMode:
        mode,
    });
  }

  function selectChatMode(
    mode:
      ChatMode,
  ) {
    setActiveChatMode(
      mode,
    );

    updateSettings({
      defaultChatMode:
        mode,
    });
  }

  /* ==================================================== */
  /* STORAGE                                              */
  /* ==================================================== */

  async function refreshStorageSize() {
    try {
      let bytes =
        0;

      for (
        let index = 0;
        index <
        window.localStorage.length;
        index += 1
      ) {
        const key =
          window.localStorage.key(
            index,
          );

        if (
          !key ||
          !key.startsWith(
            "clawbit.",
          )
        ) {
          continue;
        }

        const value =
          window.localStorage.getItem(
            key,
          );

        bytes +=
          new Blob([
            key,
            value ??
              "",
          ]).size;
      }

      setStorageSize(
        formatBytes(
          bytes,
        ),
      );
    } catch {
      setStorageSize(
        "Unavailable",
      );
    }
  }

  /* ==================================================== */
  /* EXPORT                                               */
  /* ==================================================== */

  function exportBackup() {
    const backup:
      Record<
        string,
        unknown
      > = {};

    for (
      let index = 0;
      index <
      window.localStorage.length;
      index += 1
    ) {
      const key =
        window.localStorage.key(
          index,
        );

      if (
        !key ||
        !key.startsWith(
          "clawbit.",
        )
      ) {
        continue;
      }

      const raw =
        window.localStorage.getItem(
          key,
        );

      if (
        raw ===
        null
      ) {
        continue;
      }

      try {
        backup[
          key
        ] =
          JSON.parse(
            raw,
          );
      } catch {
        backup[
          key
        ] =
          raw;
      }
    }

    const blob =
      new Blob(
        [
          JSON.stringify(
            {
              version:
                1,

              exportedAt:
                new Date().toISOString(),

              data:
                backup,
            },

            null,

            2,
          ),
        ],

        {
          type:
            "application/json",
        },
      );

    const url =
      URL.createObjectURL(
        blob,
      );

    const anchor =
      document.createElement(
        "a",
      );

    anchor.href =
      url;

    anchor.download =
      `clawbit-backup-${new Date()
        .toISOString()
        .slice(
          0,
          10,
        )}.json`;

    document.body.appendChild(
      anchor,
    );

    anchor.click();

    anchor.remove();

    URL.revokeObjectURL(
      url,
    );

    setStatus(
      "Backup exported.",
    );
  }

  /* ==================================================== */
  /* IMPORT                                               */
  /* ==================================================== */

  async function importBackup(
    file:
      File | null,
  ) {
    if (
      !file
    ) {
      return;
    }

    try {
      const text =
        await file.text();

      const parsed =
        JSON.parse(
          text,
        ) as {
          data?:
            Record<
              string,
              unknown
            >;
        };

      const data =
        parsed.data ??
        parsed;

      if (
        !data ||
        typeof data !==
          "object"
      ) {
        throw new Error(
          "Invalid backup file.",
        );
      }

      for (
        const [
          key,
          value,
        ] of Object.entries(
          data,
        )
      ) {
        if (
          !key.startsWith(
            "clawbit.",
          )
        ) {
          continue;
        }

        window.localStorage.setItem(
          key,

          typeof value ===
            "string"
            ? value
            : JSON.stringify(
                value,
              ),
        );
      }

      setStatus(
        "Backup restored. Reloading...",
      );

      window.setTimeout(
        () =>
          window.location.reload(),

        400,
      );
    } catch {
      setStatus(
        "Could not import this backup.",
      );
    } finally {
      if (
        importInputRef.current
      ) {
        importInputRef.current.value =
          "";
      }
    }
  }

  /* ==================================================== */
  /* CLEAR HELPERS                                        */
  /* ==================================================== */

  function removeKeys(
    keys:
      string[],
  ) {
    keys.forEach(
      (
        key,
      ) =>
        window.localStorage.removeItem(
          key,
        ),
    );

    void refreshStorageSize();
  }

  function clearChats() {
    if (
      settings.confirmDestructiveActions &&
      !window.confirm(
        "Clear locally saved chats?",
      )
    ) {
      return;
    }

    removeKeys(
      CHAT_STORAGE_KEYS,
    );

    setStatus(
      "Saved chats cleared.",
    );
  }

  function clearProjects() {
    if (
      settings.confirmDestructiveActions &&
      !window.confirm(
        "Clear all locally saved projects?",
      )
    ) {
      return;
    }

    removeKeys(
      PROJECT_STORAGE_KEYS,
    );

    setStatus(
      "Projects cleared.",
    );
  }

  function resetPersonalization() {
    if (
      settings.confirmDestructiveActions &&
      !window.confirm(
        "Reset profile and personalization?",
      )
    ) {
      return;
    }

    removeKeys(
      PERSONALIZATION_STORAGE_KEYS,
    );

    setActiveChatMode(
      settings.defaultChatMode,
    );

    window.dispatchEvent(
      new CustomEvent(
        "clawbit:personalization-updated",
      ),
    );

    setStatus(
      "Personalization reset.",
    );
  }

  /* ==================================================== */
  /* RESET SETTINGS                                       */
  /* ==================================================== */

  function resetSettings() {
    if (
      settings.confirmDestructiveActions &&
      !window.confirm(
        "Reset Clawbit settings to their defaults?",
      )
    ) {
      return;
    }

    writeAppSettings(
      DEFAULT_APP_SETTINGS,
    );

    setTheme(
      DEFAULT_APP_SETTINGS.themeMode,
    );

    setActiveChatMode(
      DEFAULT_APP_SETTINGS.defaultChatMode,
    );

    setSettings(
      readAppSettings(),
    );

    setStatus(
      "Settings reset.",
    );
  }

  /* ==================================================== */
  /* CLEAR EVERYTHING                                     */
  /* ==================================================== */

  function clearAllLocalData() {
    if (
      !window.confirm(
        "Clear all locally stored Clawbit data?\n\nThis removes local chats, projects, profile, personalization, settings, Library metadata and other browser-stored Clawbit data. Backend files, databases, environment variables and MCP credentials are not changed.",
      )
    ) {
      return;
    }

    const keys:
      string[] =
      [];

    for (
      let index = 0;
      index <
      window.localStorage.length;
      index += 1
    ) {
      const key =
        window.localStorage.key(
          index,
        );

      if (
        key?.startsWith(
          "clawbit.",
        )
      ) {
        keys.push(
          key,
        );
      }
    }

    removeKeys(
      keys,
    );

    window.location.reload();
  }

  /* ==================================================== */
  /* UI                                                   */
  /* ==================================================== */

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[color:var(--background)] text-[color:var(--foreground)]">
      <input
        ref={
          importInputRef
        }
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(
          event,
        ) =>
          void importBackup(
            event.target
              .files?.[
              0
            ] ??
              null,
          )
        }
      />

      <div className="mx-auto w-full max-w-[980px] px-5 pb-24 pt-7 lg:px-8 lg:pt-8">
        {/* ============================================= */}
        {/* HEADER                                        */}
        {/* ============================================= */}

        <div className="mb-7 flex items-start justify-between gap-5">
          <PageHeader
            icon={
              Settings2
            }
            title="Settings"
            description="Control appearance, chat defaults, notifications, safety confirmations, and local Clawbit data."
          />

          <button
            type="button"
            onClick={
              onExitSettings
            }
            aria-label="Close settings"
            title="Close settings"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]"
          >
            <X
              size={
                16
              }
            />
          </button>
        </div>

        <div className="space-y-4">
          {/* =========================================== */}
          {/* APPEARANCE                                  */}
          {/* =========================================== */}

          <SettingsCard>
            <SectionHeader
              icon={
                Palette
              }
              title="Appearance"
              description="Choose how Clawbit looks on this device."
            />

            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <ChoiceButton
                selected={
                  settings.themeMode ===
                  "system"
                }
                onClick={() =>
                  selectTheme(
                    "system",
                  )
                }
              >
                <Laptop
                  size={
                    14
                  }
                />

                System

                {settings.themeMode ===
                "system" ? (
                  <Check
                    size={
                      13
                    }
                  />
                ) : null}
              </ChoiceButton>

              <ChoiceButton
                selected={
                  settings.themeMode ===
                  "dark"
                }
                onClick={() =>
                  selectTheme(
                    "dark",
                  )
                }
              >
                <Moon
                  size={
                    14
                  }
                />

                Dark

                {settings.themeMode ===
                "dark" ? (
                  <Check
                    size={
                      13
                    }
                  />
                ) : null}
              </ChoiceButton>

              <ChoiceButton
                selected={
                  settings.themeMode ===
                  "light"
                }
                onClick={() =>
                  selectTheme(
                    "light",
                  )
                }
              >
                <Sun
                  size={
                    14
                  }
                />

                Light

                {settings.themeMode ===
                "light" ? (
                  <Check
                    size={
                      13
                    }
                  />
                ) : null}
              </ChoiceButton>
            </div>
          </SettingsCard>

          {/* =========================================== */}
          {/* DEFAULT MODEL                               */}
          {/* =========================================== */}

          <SettingsCard>
            <SectionHeader
              icon={
                Database
              }
              title="Default model"
              description="This model is selected automatically when a fresh chat is created."
            />

            <select
              value={
                settings.defaultModel
              }
              onChange={(
                event,
              ) =>
                updateSettings({
                  defaultModel:
                    event.target
                      .value,
                })
              }
              className="mt-4 h-11 w-full rounded-[11px] border border-[color:var(--border)] bg-[color:var(--background)] px-3 text-[12px] text-[color:var(--foreground)] outline-none shadow-none focus:border-[color:var(--border-strong)] focus:ring-0 sm:max-w-[520px]"
            >
              {availableModels.map(
                (
                  model,
                ) => (
                  <option
                    key={
                      model.id
                    }
                    value={
                      model.id
                    }
                  >
                    {
                      model.label
                    }
                  </option>
                ),
              )}
            </select>
          </SettingsCard>

          {/* =========================================== */}
          {/* DEFAULT MODE                                */}
          {/* =========================================== */}

          <SettingsCard>
            <SectionHeader
              icon={
                MessageSquare
              }
              title="Default chat mode"
              description="Choose the mode Clawbit should start with when you create a new conversation."
            />

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <ChoiceButton
                selected={
                  settings.defaultChatMode ===
                  "normal"
                }
                onClick={() =>
                  selectChatMode(
                    "normal",
                  )
                }
              >
                Normal

                {settings.defaultChatMode ===
                "normal" ? (
                  <Check
                    size={
                      13
                    }
                  />
                ) : null}
              </ChoiceButton>

              <ChoiceButton
                selected={
                  settings.defaultChatMode ===
                  "research"
                }
                onClick={() =>
                  selectChatMode(
                    "research",
                  )
                }
              >
                Research

                {settings.defaultChatMode ===
                "research" ? (
                  <Check
                    size={
                      13
                    }
                  />
                ) : null}
              </ChoiceButton>
            </div>
          </SettingsCard>

          {/* =========================================== */}
          {/* GENERAL                                     */}
          {/* =========================================== */}

          <SettingsCard>
            <SectionHeader
              icon={
                Bell
              }
              title="General"
              description="Control interface behavior and confirmation prompts."
            />

            <div className="mt-3 divide-y divide-[color:var(--border)]">
              <ToggleSetting
                checked={
                  settings.notifications
                }
                label="In-app notifications"
                description="Show Clawbit activity notifications in the top-bar notification center."
                onChange={(
                  notifications,
                ) =>
                  updateSettings({
                    notifications,
                  })
                }
              />

              <ToggleSetting
                checked={
                  settings.confirmDestructiveActions
                }
                label="Confirm destructive actions"
                description="Ask for confirmation before deleting or clearing important local data."
                onChange={(
                  confirmDestructiveActions,
                ) =>
                  updateSettings({
                    confirmDestructiveActions,
                  })
                }
              />
            </div>
          </SettingsCard>

          {/* =========================================== */}
          {/* BACKUP                                      */}
          {/* =========================================== */}

          <SettingsCard>
            <SectionHeader
              icon={
                Database
              }
              title="Backup & restore"
              description="Export your browser-stored Clawbit data or restore it from a previous backup."
            />

            <div className="mt-4 flex flex-wrap gap-2">
              <SecondaryButton
                onClick={
                  exportBackup
                }
              >
                <Download
                  size={
                    14
                  }
                />

                Export backup
              </SecondaryButton>

              <SecondaryButton
                onClick={() =>
                  importInputRef.current?.click()
                }
              >
                <Import
                  size={
                    14
                  }
                />

                Import backup
              </SecondaryButton>
            </div>
          </SettingsCard>

          {/* =========================================== */}
          {/* LOCAL DATA                                  */}
          {/* =========================================== */}

          <SettingsCard>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <SectionHeader
                icon={
                  HardDrive
                }
                title="Local data"
                description="Manage data stored by Clawbit in this browser."
              />

              <div className="rounded-[11px] border border-[color:var(--border)] bg-[color:var(--background)] px-3 py-2">
                <p className="text-[8px] font-medium uppercase tracking-[0.14em] text-[color:var(--muted-foreground)]">
                  Storage
                </p>

                <p className="mt-1 text-[11px] font-medium text-[color:var(--foreground)]">
                  {
                    storageSize
                  }
                </p>
              </div>
            </div>

            <p className="mt-4 text-[10px] leading-5 text-[color:var(--muted-foreground)]">
              These controls manage browser data only.
              Backend uploads, databases, environment variables,
              and MCP secrets are not included.
            </p>

            <div className="mt-4 grid gap-2 md:grid-cols-3">
              <DataAction
                icon={
                  MessageSquare
                }
                title="Clear chats"
                description="Remove locally saved chat history."
                onClick={
                  clearChats
                }
              />

              <DataAction
                icon={
                  Database
                }
                title="Clear projects"
                description="Remove local project data and project history."
                onClick={
                  clearProjects
                }
              />

              <DataAction
                icon={
                  RotateCcw
                }
                title="Reset personalization"
                description="Restore assistant personalization to defaults."
                onClick={
                  resetPersonalization
                }
              />
            </div>
          </SettingsCard>

          {/* =========================================== */}
          {/* RESET                                       */}
          {/* =========================================== */}

          <SettingsCard>
            <SectionHeader
              icon={
                ShieldAlert
              }
              title="Reset"
              description="Reset settings or remove all browser-stored Clawbit data."
            />

            <div className="mt-4 flex flex-wrap gap-2">
              <SecondaryButton
                onClick={
                  resetSettings
                }
              >
                <RotateCcw
                  size={
                    14
                  }
                />

                Reset settings
              </SecondaryButton>

              <button
                type="button"
                onClick={
                  clearAllLocalData
                }
                className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-red-500/20 px-3 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/[0.08]"
              >
                <Trash2
                  size={
                    14
                  }
                />

                Clear all local data
              </button>
            </div>
          </SettingsCard>

          {status ? (
            <div className="rounded-[11px] border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2.5 text-[10px] text-[color:var(--muted-foreground)]">
              {
                status
              }
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ====================================================== */
/* PAGE HEADER                                            */
/* ====================================================== */

function PageHeader({
  icon: Icon,
  title,
  description,
}: {
  icon:
    typeof Settings2;

  title:
    string;

  description:
    string;
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] border border-[color:var(--border)] bg-[color:var(--surface)]">
        <Icon
          size={
            18
          }
          className="text-[color:var(--foreground)]"
        />
      </div>

      <div>
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

/* ====================================================== */
/* CARD                                                   */
/* ====================================================== */

function SettingsCard({
  children,
}: {
  children:
    ReactNode;
}) {
  return (
    <section className="rounded-[18px] border border-[color:var(--border)] bg-[color:var(--surface)] p-5 text-[color:var(--foreground)]">
      {
        children
      }
    </section>
  );
}

/* ====================================================== */
/* SECTION HEADER                                         */
/* ====================================================== */

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon:
    typeof Settings2;

  title:
    string;

  description:
    string;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <Icon
          size={
            14
          }
          className="text-[color:var(--muted-foreground)]"
        />

        <p className="text-[12px] font-medium text-[color:var(--foreground)]">
          {
            title
          }
        </p>
      </div>

      <p className="mt-1.5 text-[10px] leading-4 text-[color:var(--muted-foreground)]">
        {
          description
        }
      </p>
    </div>
  );
}

/* ====================================================== */
/* CHOICE                                                 */
/* ====================================================== */

function ChoiceButton({
  selected,
  onClick,
  children,
}: {
  selected:
    boolean;

  onClick:
    () => void;

  children:
    ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={
        onClick
      }
      className={cn(
        "flex h-10 items-center justify-center gap-2 rounded-[11px] border px-3 text-[11px] transition-colors",

        selected
          ? "border-[color:var(--border-strong)] bg-[color:var(--surface-alt)] font-medium text-[color:var(--foreground)]"
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
/* TOGGLE                                                 */
/* ====================================================== */

function ToggleSetting({
  checked,
  onChange,
  label,
  description,
}: {
  checked:
    boolean;

  onChange:
    (checked: boolean) => void;

  label:
    string;

  description:
    string;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-[color:var(--foreground)]">
          {
            label
          }
        </p>

        <p className="mt-1 text-[10px] leading-4 text-[color:var(--muted-foreground)]">
          {
            description
          }
        </p>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={
          checked
        }
        onClick={() =>
          onChange(
            !checked,
          )
        }
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full border transition-colors",

          checked
            ? "border-transparent bg-[color:var(--accent)]"
            : "border-[color:var(--border)] bg-[color:var(--surface-alt)]",
        )}
      >
        <span
          className={cn(
            "absolute top-[3px] h-4 w-4 rounded-full transition-transform",

            checked
              ? "translate-x-[22px] bg-[color:var(--accent-foreground)]"
              : "translate-x-[4px] bg-[color:var(--muted-foreground)]",
          )}
        />
      </button>
    </div>
  );
}

/* ====================================================== */
/* BUTTON                                                 */
/* ====================================================== */

function SecondaryButton({
  children,
  onClick,
}: {
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
      className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-[color:var(--border)] bg-transparent px-3 text-[12px] text-[color:var(--foreground)] transition-colors hover:bg-[color:var(--accent-hover)]"
    >
      {
        children
      }
    </button>
  );
}

/* ====================================================== */
/* DATA ACTION                                            */
/* ====================================================== */

function DataAction({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon:
    typeof Settings2;

  title:
    string;

  description:
    string;

  onClick:
    () => void;
}) {
  return (
    <button
      type="button"
      onClick={
        onClick
      }
      className="flex min-h-[82px] items-start gap-3 rounded-[12px] border border-[color:var(--border)] bg-[color:var(--background)] p-3 text-left transition-colors hover:bg-[color:var(--accent-hover)]"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--muted-foreground)]">
        <Icon
          size={
            14
          }
        />
      </div>

      <div>
        <p className="text-[11px] font-medium text-[color:var(--foreground)]">
          {
            title
          }
        </p>

        <p className="mt-1 text-[9px] leading-4 text-[color:var(--muted-foreground)]">
          {
            description
          }
        </p>
      </div>
    </button>
  );
}

/* ====================================================== */
/* FORMAT BYTES                                           */
/* ====================================================== */

function formatBytes(
  bytes:
    number,
) {
  if (
    bytes <
    1024
  ) {
    return `${bytes} B`;
  }

  const kb =
    bytes /
    1024;

  if (
    kb <
    1024
  ) {
    return `${kb.toFixed(
      1,
    )} KB`;
  }

  return `${(
    kb /
    1024
  ).toFixed(
    1,
  )} MB`;
}