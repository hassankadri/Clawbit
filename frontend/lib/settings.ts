import type { ChatMode } from "@/lib/api";
import { DEFAULT_MODEL_ID, MODELS } from "@/lib/models";

export type ThemeMode =
  | "system"
  | "dark"
  | "light";

export interface AppSettings {
  notifications: boolean;
  confirmDestructiveActions: boolean;
  defaultModel: string;
  defaultChatMode: ChatMode;
  themeMode: ThemeMode;
}

export const APP_SETTINGS_STORAGE_KEY =
  "clawbit.settings.general.v1";

export const APP_SETTINGS_UPDATED_EVENT =
  "clawbit:settings-updated";

export const DEFAULT_APP_SETTINGS: AppSettings =
  {
    notifications: true,

    confirmDestructiveActions:
      true,

    defaultModel:
      DEFAULT_MODEL_ID,

    defaultChatMode:
      "normal",

    themeMode:
      "system",
  };

function isAvailableModel(
  modelId: unknown,
): modelId is string {
  return (
    typeof modelId ===
      "string" &&
    MODELS.some(
      (model) =>
        model.id === modelId,
    )
  );
}

function normalizeThemeMode(
  value: unknown,
): ThemeMode {
  if (
    value === "dark" ||
    value === "light" ||
    value === "system"
  ) {
    return value;
  }

  return DEFAULT_APP_SETTINGS.themeMode;
}

function normalizeChatMode(
  value: unknown,
): ChatMode {
  return value ===
    "research"
    ? "research"
    : "normal";
}

export function normalizeAppSettings(
  value:
    | Partial<AppSettings>
    | null
    | undefined,
): AppSettings {
  return {
    notifications:
      typeof value?.notifications ===
      "boolean"
        ? value.notifications
        : DEFAULT_APP_SETTINGS.notifications,

    confirmDestructiveActions:
      typeof value?.confirmDestructiveActions ===
      "boolean"
        ? value.confirmDestructiveActions
        : DEFAULT_APP_SETTINGS.confirmDestructiveActions,

    defaultModel:
      isAvailableModel(
        value?.defaultModel,
      )
        ? value.defaultModel
        : DEFAULT_APP_SETTINGS.defaultModel,

    defaultChatMode:
      normalizeChatMode(
        value?.defaultChatMode,
      ),

    themeMode:
      normalizeThemeMode(
        value?.themeMode,
      ),
  };
}

export function readAppSettings():
  AppSettings {
  if (
    typeof window ===
    "undefined"
  ) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    const rawValue =
      window.localStorage.getItem(
        APP_SETTINGS_STORAGE_KEY,
      );

    if (!rawValue) {
      return DEFAULT_APP_SETTINGS;
    }

    const parsed =
      JSON.parse(
        rawValue,
      ) as Partial<AppSettings>;

    return normalizeAppSettings(
      parsed,
    );
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function writeAppSettings(
  value: Partial<AppSettings>,
): AppSettings {
  const nextSettings =
    normalizeAppSettings({
      ...readAppSettings(),

      ...value,
    });

  if (
    typeof window !==
    "undefined"
  ) {
    window.localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,

      JSON.stringify(
        nextSettings,
      ),
    );

    window.dispatchEvent(
      new CustomEvent<AppSettings>(
        APP_SETTINGS_UPDATED_EVENT,

        {
          detail:
            nextSettings,
        },
      ),
    );
  }

  return nextSettings;
}

export function resetAppSettings():
  AppSettings {
  return writeAppSettings(
    DEFAULT_APP_SETTINGS,
  );
}
