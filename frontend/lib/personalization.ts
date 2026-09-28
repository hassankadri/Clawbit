export type ResponseTone =
  | "Balanced"
  | "Friendly"
  | "Professional"
  | "Direct";

export type ResponseLength =
  | "Short"
  | "Balanced"
  | "Detailed";

export interface PersonalizationPreferences {
  assistantName: string;

  responseTone:
    ResponseTone;

  responseLength:
    ResponseLength;

  customInstructions:
    string;
}

/*
 * This is the same storage key used by
 * the Personalization page.
 */
export const PERSONALIZATION_STORAGE_KEY =
  "clawbit.customization.state.v1";

/*
 * Safe defaults.
 *
 * If the user has never changed Personalization,
 * Clawbit behaves normally.
 */
export const DEFAULT_PERSONALIZATION:
  PersonalizationPreferences =
  {
    assistantName:
      "Clawbit",

    responseTone:
      "Balanced",

    responseLength:
      "Balanced",

    customInstructions:
      "",
  };

/* ====================================================== */
/* VALIDATION                                             */
/* ====================================================== */

function isResponseTone(
  value: unknown,
): value is ResponseTone {
  return (
    value === "Balanced" ||
    value === "Friendly" ||
    value === "Professional" ||
    value === "Direct"
  );
}

function isResponseLength(
  value: unknown,
): value is ResponseLength {
  return (
    value === "Short" ||
    value === "Balanced" ||
    value === "Detailed"
  );
}

/* ====================================================== */
/* READ PERSONALIZATION                                   */
/* ====================================================== */

export function getPersonalizationPreferences():
  PersonalizationPreferences {
  if (
    typeof window ===
    "undefined"
  ) {
    return {
      ...DEFAULT_PERSONALIZATION,
    };
  }

  try {
    const raw =
      window.localStorage.getItem(
        PERSONALIZATION_STORAGE_KEY,
      );

    if (!raw) {
      return {
        ...DEFAULT_PERSONALIZATION,
      };
    }

    const parsed =
      JSON.parse(
        raw,
      ) as Record<
        string,
        unknown
      >;

    const assistantName =
      typeof parsed.assistantName ===
        "string" &&
      parsed.assistantName.trim()
        ? parsed.assistantName
            .trim()
            .slice(
              0,
              80,
            )
        : DEFAULT_PERSONALIZATION.assistantName;

    const responseTone =
      isResponseTone(
        parsed.responseTone,
      )
        ? parsed.responseTone
        : DEFAULT_PERSONALIZATION.responseTone;

    const responseLength =
      isResponseLength(
        parsed.responseLength,
      )
        ? parsed.responseLength
        : DEFAULT_PERSONALIZATION.responseLength;

    const customInstructions =
      typeof parsed.customInstructions ===
      "string"
        ? parsed.customInstructions
            .trim()
            .slice(
              0,
              4000,
            )
        : "";

    return {
      assistantName,

      responseTone,

      responseLength,

      customInstructions,
    };
  } catch {
    return {
      ...DEFAULT_PERSONALIZATION,
    };
  }
}

/* ====================================================== */
/* BACKEND PAYLOAD                                        */
/* ====================================================== */

export interface PersonalizationRequestPayload {
  assistant_name:
    string;

  response_tone:
    "balanced"
    | "friendly"
    | "professional"
    | "direct";

  response_length:
    "short"
    | "balanced"
    | "detailed";

  custom_instructions:
    string;
}

export function getPersonalizationRequestPayload():
  PersonalizationRequestPayload {
  const preferences =
    getPersonalizationPreferences();

  return {
    assistant_name:
      preferences.assistantName,

    response_tone:
      preferences.responseTone.toLowerCase() as
        PersonalizationRequestPayload["response_tone"],

    response_length:
      preferences.responseLength.toLowerCase() as
        PersonalizationRequestPayload["response_length"],

    custom_instructions:
      preferences.customInstructions,
  };
}