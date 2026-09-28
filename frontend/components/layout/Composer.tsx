"use client";

import * as Popover from "@radix-ui/react-popover";
import { motion } from "framer-motion";

import {
  ArrowUp,
  Check,
  ChevronDown,
  Mic,
  Paperclip,
  Plus,
  Telescope,
  X,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";

import TextareaAutosize from "react-textarea-autosize";

import {
  getActiveChatMode,
  setActiveChatMode,
  uploadAttachment,
  type ChatMode,
} from "@/lib/api";

import { MODELS } from "@/lib/models";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

interface ComposerProps {
  assistantName: string;

  loading: boolean;
  model: string;
  threadId: string;
  theme: Theme;

  prefill?: {
    id: number;
    text: string;
  } | null;

  onModelChange: (
    model: string,
  ) => void;

  onSend: (
    message: string,
    attachmentIds?: string[],
  ) => Promise<void>;

  onAttachmentsCommitted?: (
    attachments: Array<{
      id: string;
      name: string;
      size: number;
      mimeType: string;
      detail: string;
      preview?: string;
      kind: AttachmentKind;
    }>,
  ) => void;
}

type AttachmentStatus =
  | "uploading"
  | "ready"
  | "error";

type AttachmentKind =
  | "document"
  | "image";

interface AttachmentItem {
  id: string;
  serverId?: string;

  kind: AttachmentKind;

  name: string;
  detail: string;

  size: number;
  mimeType: string;

  status: AttachmentStatus;

  progress: number;

  error?: string;
  preview?: string;
}

interface SpeechRecognitionResultLike {
  transcript: string;
  isFinal?: boolean;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionEventLike {
  results: Array<{
    0: SpeechRecognitionResultLike;
  }>;
}

interface SpeechRecognitionLike {
  lang: string;

  interimResults: boolean;
  continuous: boolean;

  onresult:
    | ((
        event:
          SpeechRecognitionEventLike,
      ) => void)
    | null;

  onend:
    | (() => void)
    | null;

  onerror:
    | ((
        event:
          SpeechRecognitionErrorEventLike,
      ) => void)
    | null;

  onstart:
    | (() => void)
    | null;

  start: () => void;
  stop: () => void;
  abort: () => void;
}

/* ====================================================== */
/* FILE SUPPORT                                           */
/* ====================================================== */

const acceptedExtensions = [
  ".pdf",
  ".docx",
  ".txt",
  ".md",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
];

const acceptedMimeTypes =
  new Set([
    "application/pdf",

    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

    "text/plain",
    "text/markdown",
    "text/csv",

    "image/png",
    "image/jpeg",
    "image/webp",
  ]);

const mimeExtensionMap:
  Record<string, string> = {
    "application/pdf":
      "pdf",

    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",

    "text/plain":
      "txt",

    "text/markdown":
      "md",

    "text/csv":
      "csv",

    "image/png":
      "png",

    "image/jpeg":
      "jpg",

    "image/webp":
      "webp",
  };

const availableModels =
  MODELS.filter(
    (
      item,
    ) =>
      item.available,
  );

/* ====================================================== */
/* COMPOSER                                               */
/* ====================================================== */

export default function Composer({
  assistantName,

  loading,
  model,
  threadId,
  theme,

  prefill,

  onModelChange,
  onSend,
  onAttachmentsCommitted,
}: ComposerProps) {
  const [
    message,
    setMessage,
  ] =
    useState("");

  const [
    modelOpen,
    setModelOpen,
  ] =
    useState(false);

  const [
    chatMode,
    setChatMode,
  ] =
    useState<ChatMode>(
      () =>
        getActiveChatMode(),
    );

  const [
    attachments,
    setAttachments,
  ] =
    useState<
      AttachmentItem[]
    >([]);

  const [
    isRecording,
    setIsRecording,
  ] =
    useState(false);

  const [
    isDragging,
    setIsDragging,
  ] =
    useState(false);

  const [
    voiceNotice,
    setVoiceNotice,
  ] =
    useState<
      string | null
    >(null);

  const textareaRef =
    useRef<HTMLTextAreaElement | null>(
      null,
    );

  const fileInputRef =
    useRef<HTMLInputElement | null>(
      null,
    );

  const recognitionRef =
    useRef<SpeechRecognitionLike | null>(
      null,
    );

  const dragDepthRef =
    useRef(0);

  const attachmentsRef =
    useRef<
      AttachmentItem[]
    >([]);

  const voiceBaseMessageRef =
    useRef("");

  const voiceTranscriptRef =
    useRef("");

  const uploadAbortersRef =
    useRef(
      new Map<
        string,
        {
          abort: () => void;
          promise:
            Promise<unknown>;
        }
      >(),
    );

  /* ==================================================== */
  /* INITIAL FOCUS                                        */
  /* ==================================================== */

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  /* ==================================================== */
  /* PREFILL                                              */
  /* ==================================================== */

  useEffect(() => {
    if (!prefill) {
      return;
    }

    queueMicrotask(
      () => {
        setMessage(
          prefill.text,
        );

        setVoiceNotice(
          null,
        );
      },
    );

    const frameId =
      window.requestAnimationFrame(
        () => {
          const textarea =
            textareaRef.current;

          if (
            !textarea
          ) {
            return;
          }

          textarea.focus();

          textarea.setSelectionRange(
            prefill.text.length,
            prefill.text.length,
          );
        },
      );

    return () => {
      window.cancelAnimationFrame(
        frameId,
      );
    };
  }, [
    prefill,
  ]);

  /* ==================================================== */
  /* CHAT MODE SYNC                                       */
  /* ==================================================== */

  useEffect(() => {
    function handleModeUpdate(
      event: Event,
    ) {
      const detail =
        (
          event as CustomEvent<{
            mode?: ChatMode;
          }>
        ).detail;

      if (
        detail?.mode ===
          "normal" ||
        detail?.mode ===
          "research"
      ) {
        setChatMode(
          detail.mode,
        );
      }
    }

    window.addEventListener(
      "clawbit:chat-mode-updated",

      handleModeUpdate,
    );

    return () => {
      window.removeEventListener(
        "clawbit:chat-mode-updated",

        handleModeUpdate,
      );
    };
  }, []);

  /* ==================================================== */
  /* CLEANUP                                              */
  /* ==================================================== */

  useEffect(() => {
    const aborters =
      uploadAbortersRef.current;

    return () => {
      recognitionRef.current?.abort?.();

      recognitionRef.current =
        null;

      aborters.forEach(
        (
          entry,
        ) =>
          entry.abort(),
      );

      aborters.clear();
    };
  }, []);

  useEffect(() => {
    attachmentsRef.current =
      attachments;
  }, [
    attachments,
  ]);

  /* ==================================================== */
  /* MODEL                                                */
  /* ==================================================== */

  const selectedModel =
    useMemo(
      () =>
        availableModels.find(
          (
            item,
          ) =>
            item.id ===
            model,
        ) ??
        availableModels[
          0
        ] ??
        MODELS[
          0
        ],

      [
        model,
      ],
    );

  const canSend =
    message
      .trim()
      .length >
      0 ||
    attachments.some(
      (
        item,
      ) =>
        item.status ===
          "ready" &&
        Boolean(
          item.serverId,
        ),
    );

  function changeChatMode(
    mode:
      ChatMode,
  ) {
    setChatMode(
      mode,
    );

    setActiveChatMode(
      mode,
    );

    window.dispatchEvent(
      new CustomEvent(
        "clawbit:chat-mode-updated",

        {
          detail: {
            mode,
          },
        },
      ),
    );
  }

  /* ==================================================== */
  /* ATTACHMENT STATE                                     */
  /* ==================================================== */

  function patchAttachment(
    id:
      string,

    updater: (
      item:
        AttachmentItem,
    ) => AttachmentItem,
  ) {
    setAttachments(
      (
        current,
      ) =>
        current.map(
          (
            item,
          ) =>
            item.id ===
            id
              ? updater(
                  item,
                )
              : item,
        ),
    );
  }

  function removeAttachment(
    id:
      string,
  ) {
    uploadAbortersRef.current
      .get(
        id,
      )
      ?.abort();

    uploadAbortersRef.current.delete(
      id,
    );

    setAttachments(
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

  function normalizeUploadFile(
    file:
      File,
  ) {
    if (
      /\.[a-z0-9]+$/i.test(
        file.name,
      )
    ) {
      return file;
    }

    const extension =
      mimeExtensionMap[
        file.type.toLowerCase()
      ];

    if (
      !extension
    ) {
      return file;
    }

    return new File(
      [
        file,
      ],

      `${file.name}.${extension}`,

      {
        type:
          file.type,

        lastModified:
          file.lastModified,
      },
    );
  }

  /* ==================================================== */
  /* VOICE                                                */
  /* ==================================================== */

  function stopVoiceRecording() {
    recognitionRef.current?.stop?.();
  }

  function finalizeVoicePrompt() {
    const finalText =
      voiceTranscriptRef.current.trim();

    recognitionRef.current =
      null;

    setIsRecording(
      false,
    );

    if (
      finalText
    ) {
      setMessage(
        finalText,
      );
    }
  }

  function startVoiceRecording() {
    const recognitionWindow =
      window as Window & {
        SpeechRecognition?:
          new () => SpeechRecognitionLike;

        webkitSpeechRecognition?:
          new () => SpeechRecognitionLike;
      };

    const SpeechRecognition =
      recognitionWindow.SpeechRecognition ??
      recognitionWindow.webkitSpeechRecognition;

    if (
      !SpeechRecognition
    ) {
      setVoiceNotice(
        "Voice input is not supported in this browser. Try Chrome or Edge.",
      );

      return;
    }

    if (
      recognitionRef.current
    ) {
      stopVoiceRecording();

      return;
    }

    const recognition =
      new SpeechRecognition();

    voiceBaseMessageRef.current =
      message;

    voiceTranscriptRef.current =
      message.trim();

    setVoiceNotice(
      null,
    );

    recognition.lang =
      "en-US";

    recognition.interimResults =
      true;

    recognition.continuous =
      false;

    recognition.onstart =
      () => {
        setIsRecording(
          true,
        );
      };

    recognition.onresult =
      (
        event,
      ) => {
        const transcript =
          Array.from(
            event.results,
          )
            .map(
              (
                result,
              ) =>
                result[
                  0
                ]
                  ?.transcript ??
                "",
            )
            .join(
              " ",
            )
            .trim();

        const combinedText =
          [
            voiceBaseMessageRef.current.trim(),

            transcript,
          ]
            .filter(
              Boolean,
            )
            .join(
              " ",
            )
            .trim();

        voiceTranscriptRef.current =
          combinedText;

        setMessage(
          combinedText,
        );

        textareaRef.current?.focus();
      };

    recognition.onend =
      () => {
        finalizeVoicePrompt();
      };

    recognition.onerror =
      (
        event,
      ) => {
        recognitionRef.current =
          null;

        setIsRecording(
          false,
        );

        voiceTranscriptRef.current =
          voiceBaseMessageRef.current;

        if (
          event.error ===
            "not-allowed" ||
          event.error ===
            "service-not-allowed"
        ) {
          setVoiceNotice(
            "Microphone access was denied. Please allow access and try again.",
          );
        } else {
          setVoiceNotice(
            "Voice input stopped unexpectedly. Please try again.",
          );
        }
      };

    recognitionRef.current =
      recognition;

    try {
      recognition.start();
    } catch {
      recognitionRef.current =
        null;

      setIsRecording(
        false,
      );

      setVoiceNotice(
        "Voice input could not start in this browser.",
      );
    }
  }

  /* ==================================================== */
  /* FILE HELPERS                                         */
  /* ==================================================== */

  function formatBytes(
    size:
      number,
  ) {
    if (
      size <
      1024
    ) {
      return `${size} B`;
    }

    if (
      size <
      1024 *
        1024
    ) {
      return `${Math.round(
        size /
          1024,
      )} KB`;
    }

    return `${(
      size /
      (
        1024 *
        1024
      )
    ).toFixed(
      1,
    )} MB`;
  }

  function classifyFile(
    file:
      File,
  ):
    | AttachmentKind
    | null {
    const lowerName =
      file.name.toLowerCase();

    const mimeType =
      file.type.toLowerCase();

    const isDocument =
      acceptedExtensions.some(
        (
          extension,
        ) =>
          lowerName.endsWith(
            extension,
          ),
      ) &&
      !mimeType.startsWith(
        "image/",
      );

    const isImage =
      mimeType.startsWith(
        "image/",
      ) ||
      /\.(png|jpg|jpeg|webp)$/i.test(
        file.name,
      );

    if (
      isImage
    ) {
      return "image";
    }

    if (
      isDocument
    ) {
      return "document";
    }

    if (
      acceptedMimeTypes.has(
        mimeType,
      )
    ) {
      return mimeType.startsWith(
        "image/",
      )
        ? "image"
        : "document";
    }

    return null;
  }

  function summarizeFile(
    file:
      File,

    kind:
      AttachmentKind,
  ) {
    return {
      detail:
        `${
          kind ===
          "image"
            ? "Image"
            : "Document"
        } · ${formatBytes(
          file.size,
        )}`,

      kind,

      mimeType:
        file.type ||
        "",

      name:
        file.name,

      size:
        file.size,
    };
  }

  /* ==================================================== */
  /* FILE UPLOAD                                          */
  /* ==================================================== */

  async function addFiles(
    list:
      FileList | null,
  ) {
    if (
      !list?.length
    ) {
      return;
    }

    const files =
      Array.from(
        list,
      );

    for (
      const file of
      files
    ) {
      const kind =
        classifyFile(
          file,
        );

      const uploadFile =
        normalizeUploadFile(
          file,
        );

      const localId =
        crypto.randomUUID();

      if (
        !kind
      ) {
        setAttachments(
          (
            current,
          ) => [
            {
              id:
                localId,

              kind:
                "document",

              name:
                file.name,

              detail:
                `Unsupported file · ${formatBytes(
                  file.size,
                )}`,

              size:
                file.size,

              mimeType:
                file.type ||
                "",

              status:
                "error",

              progress:
                0,

              error:
                "Unsupported file type. Upload PDF, DOCX, TXT, MD, CSV, or images.",
            },

            ...current,
          ],
        );

        continue;
      }

      const summary =
        summarizeFile(
          file,
          kind,
        );

      setAttachments(
        (
          current,
        ) => [
          {
            id:
              localId,

            ...summary,

            status:
              "uploading",

            progress:
              0,
          },

          ...current,
        ],
      );

      const uploader =
        uploadAttachment(
          threadId,
          uploadFile,
          {
            onProgress:
              (
                progress,
              ) => {
                patchAttachment(
                  localId,

                  (
                    item,
                  ) => ({
                    ...item,

                    progress,
                  }),
                );
              },
          },
        );

      uploadAbortersRef.current.set(
        localId,
        uploader,
      );

      uploader.promise
        .then(
          (
            response,
          ) => {
            patchAttachment(
              localId,

              (
                item,
              ) => ({
                ...item,

                serverId:
                  response.attachment_id,

                preview:
                  response.preview,

                progress:
                  100,

                status:
                  "ready",

                mimeType:
                  response.mime_type ||
                  item.mimeType,

                detail:
                  `${
                    item.kind ===
                    "image"
                      ? "Image"
                      : "Document"
                  } · ${formatBytes(
                    item.size,
                  )}`,
              }),
            );
          },
        )
        .catch(
          (
            error:
              Error,
          ) => {
            patchAttachment(
              localId,

              (
                item,
              ) => ({
                ...item,

                error:
                  error.message ||
                  "Upload failed. Please try again.",

                status:
                  "error",
              }),
            );
          },
        )
        .finally(
          () => {
            uploadAbortersRef.current.delete(
              localId,
            );
          },
        );
    }
  }

  async function waitForUploads() {
    const pending =
      attachmentsRef.current
        .map(
          (
            item,
          ) =>
            uploadAbortersRef.current
              .get(
                item.id,
              )
              ?.promise,
        )
        .filter(
          (
            promise,
          ):
            promise is Promise<unknown> =>
              Boolean(
                promise,
              ),
        );

    if (
      pending.length ===
      0
    ) {
      return;
    }

    await Promise.allSettled(
      pending,
    );
  }

  /* ==================================================== */
  /* DRAG / DROP                                          */
  /* ==================================================== */

  async function handleDrop(
    event:
      DragEvent<HTMLDivElement>,
  ) {
    event.preventDefault();

    dragDepthRef.current =
      0;

    setIsDragging(
      false,
    );

    await addFiles(
      event.dataTransfer.files,
    );
  }

  function handleDragEnter(
    event:
      DragEvent<HTMLDivElement>,
  ) {
    event.preventDefault();

    dragDepthRef.current +=
      1;

    setIsDragging(
      true,
    );
  }

  function handleDragLeave(
    event:
      DragEvent<HTMLDivElement>,
  ) {
    event.preventDefault();

    dragDepthRef.current -=
      1;

    if (
      dragDepthRef.current <=
      0
    ) {
      dragDepthRef.current =
        0;

      setIsDragging(
        false,
      );
    }
  }

  /* ==================================================== */
  /* SEND                                                 */
  /* ==================================================== */

  async function send(
    overrideMessage?:
      string,
  ) {
    if (
      loading
    ) {
      return;
    }

    await waitForUploads();

    const readyAttachmentIds =
      attachmentsRef.current
        .filter(
          (
            item,
          ) =>
            item.status ===
              "ready" &&
            Boolean(
              item.serverId,
            ),
        )
        .map(
          (
            item,
          ) =>
            item.serverId!,
        );

    const readyAttachments =
      attachmentsRef.current
        .filter(
          (
            item,
          ) =>
            item.status ===
              "ready" &&
            Boolean(
              item.serverId,
            ),
        )
        .map(
          (
            item,
          ) => ({
            id:
              item.serverId!,

            name:
              item.name,

            size:
              item.size,

            mimeType:
              item.mimeType,

            detail:
              item.detail,

            preview:
              item.preview,

            kind:
              item.kind,
          }),
        );

    const trimmed =
      (
        overrideMessage ??
        message
      ).trim();

    if (
      !trimmed &&
      readyAttachmentIds.length ===
        0
    ) {
      return;
    }

    onAttachmentsCommitted?.(
      readyAttachments,
    );

    setMessage("");

    setAttachments([]);

    setVoiceNotice(
      null,
    );

    await onSend(
      trimmed,
      readyAttachmentIds,
    );
  }

  /* ==================================================== */
  /* UI                                                   */
  /* ==================================================== */

  return (
    <div className="px-5 pb-5 pt-2 lg:px-8">
      <motion.div
        layout

        onDragEnter={
          handleDragEnter
        }

        onDragOver={(
          event,
        ) => {
          event.preventDefault();

          setIsDragging(
            true,
          );
        }}

        onDragLeave={
          handleDragLeave
        }

        onDrop={
          handleDrop
        }

        className={cn(
          "mx-auto max-w-[860px] overflow-visible rounded-[26px] border transition-colors",

          theme === "dark"
            ? "border-white/[0.09] bg-[#202020]"
            : "border-black/[0.10] bg-white",

          isDragging
            ? theme ===
              "dark"
              ? "ring-2 ring-white/[0.18]"
              : "ring-2 ring-black/[0.14]"
            : "",
        )}
      >
        {/* ============================================= */}
        {/* ATTACHMENTS                                   */}
        {/* ============================================= */}

        {attachments.length >
        0 ? (
          <div className="px-4 pb-1 pt-3">
            <div className="flex flex-wrap gap-2">
              {attachments.map(
                (
                  item,
                ) => (
                  <div
                    key={
                      item.id
                    }
                    className={cn(
                      "flex max-w-[300px] items-center gap-2 rounded-[12px] border px-3 py-2",

                      item.status ===
                      "error"
                        ? theme ===
                          "dark"
                          ? "border-red-500/30 bg-red-500/[0.08] text-red-100"
                          : "border-red-200 bg-red-50 text-red-900"
                        : theme ===
                          "dark"
                          ? "border-white/[0.08] bg-[#292929] text-zinc-100"
                          : "border-black/[0.09] bg-[#f7f7f7] text-zinc-900",
                    )}
                  >
                    <Paperclip
                      size={
                        14
                      }
                      className={cn(
                        "shrink-0",

                        theme === "dark"
                          ? "text-zinc-500"
                          : "text-zinc-500",
                      )}
                    />

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium">
                        {
                          item.name
                        }
                      </p>

                      <p
                        className={cn(
                          "mt-0.5 truncate text-[9px]",

                          item.status ===
                          "error"
                            ? theme ===
                              "dark"
                              ? "text-red-300"
                              : "text-red-600"
                            : "text-zinc-500",
                        )}
                      >
                        {item.status ===
                        "uploading"
                          ? `Uploading ${item.progress}%`
                          : item.status ===
                              "error"
                            ? item.error ??
                              "Upload failed"
                            : item.detail}
                      </p>
                    </div>

                    <button
                      type="button"
                      aria-label={`Remove ${item.name}`}
                      onClick={() =>
                        removeAttachment(
                          item.id,
                        )
                      }
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors",

                        theme === "dark"
                          ? "text-zinc-500 hover:bg-white/[0.08] hover:text-white"
                          : "text-zinc-500 hover:bg-black/[0.06] hover:text-black",
                      )}
                    >
                      <X
                        size={
                          12
                        }
                      />
                    </button>
                  </div>
                ),
              )}
            </div>
          </div>
        ) : null}

        {/* ============================================= */}
        {/* MAIN ROW                                      */}
        {/* ============================================= */}

        <div className="grid min-h-[56px] grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-1 px-2 py-[7px]">
          {/* ADD FILES */}

          <TooltipButton
            label="Add files"
            theme={theme}
          >
            <motion.button
              type="button"

              whileTap={{
                scale:
                  0.94,
              }}

              onClick={() =>
                fileInputRef.current?.click()
              }

              aria-label="Add files"

              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-full transition-colors",

                theme === "dark"
                  ? "text-zinc-300 hover:bg-white/[0.07] hover:text-white"
                  : "text-zinc-600 hover:bg-black/[0.055] hover:text-black",
              )}
            >
              <Plus
                size={
                  21
                }
                strokeWidth={
                  1.8
                }
              />
            </motion.button>
          </TooltipButton>

          {/* INPUT */}

          <TextareaAutosize
            ref={
              textareaRef
            }

            minRows={
              1
            }

            maxRows={
              6
            }

            value={
              message
            }

            placeholder={`Ask ${
              assistantName.trim() ||
              "Clawbit"
            }`}

            onChange={(
              event,
            ) =>
              setMessage(
                event
                  .target
                  .value,
              )
            }

            onKeyDown={(
              event,
            ) => {
              if (
                event.key ===
                  "Enter" &&
                !event.shiftKey
              ) {
                event.preventDefault();

                void send();
              }
            }}

            className={cn(
              "block w-full min-w-0 resize-none border-0 bg-transparent px-3 py-0 text-[15px] font-normal leading-[24px] tracking-[-0.01em]",

              "outline-none ring-0 shadow-none",

              "focus:border-0 focus:outline-none focus:ring-0 focus:shadow-none",

              "focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none",

              theme === "dark"
                ? "text-zinc-100 placeholder:text-zinc-500"
                : "text-zinc-900 placeholder:text-zinc-500",
            )}

            style={{
              outline:
                "none",

              border:
                "none",

              boxShadow:
                "none",
            }}
          />

          {/* =========================================== */}
          {/* RIGHT CONTROLS                              */}
          {/* =========================================== */}

          <div className="flex h-10 shrink-0 items-center gap-0.5">
            {/* MODEL */}

            <Popover.Root
              open={
                modelOpen
              }
              onOpenChange={
                setModelOpen
              }
            >
              <Popover.Trigger
                asChild
              >
                <motion.button
                  type="button"

                  whileTap={{
                    scale:
                      0.97,
                  }}

                  className={cn(
                    "flex h-9 max-w-[215px] shrink-0 items-center gap-1.5 rounded-[10px] border border-transparent px-2.5 text-[12px] font-medium transition-colors",

                    theme === "dark"
                      ? "text-zinc-300 hover:bg-white/[0.06] hover:text-white"
                      : "text-zinc-700 hover:bg-black/[0.045] hover:text-black",

                    modelOpen
                      ? theme ===
                        "dark"
                        ? "bg-white/[0.07]"
                        : "bg-black/[0.05]"
                      : "",
                  )}
                >
                  {chatMode ===
                  "research" ? (
                    <Telescope
                      size={
                        14
                      }
                      className="shrink-0"
                    />
                  ) : null}

                  <span className="max-w-[165px] truncate">
                    {
                      selectedModel.label
                    }
                  </span>

                  <motion.span
                    animate={{
                      rotate:
                        modelOpen
                          ? 180
                          : 0,
                    }}
                    transition={{
                      duration:
                        0.18,
                    }}
                  >
                    <ChevronDown
                      size={
                        13
                      }
                      className="text-zinc-500"
                    />
                  </motion.span>
                </motion.button>
              </Popover.Trigger>

              <Popover.Portal
                forceMount
              >
                <Popover.Content
                  forceMount

                  side="top"

                  align="end"

                  sideOffset={
                    10
                  }

                  asChild
                >
                  <motion.div
                    initial={
                      false
                    }

                    animate={
                      modelOpen
                        ? {
                            opacity:
                              1,

                            y:
                              0,

                            scale:
                              1,

                            pointerEvents:
                              "auto",
                          }
                        : {
                            opacity:
                              0,

                            y:
                              8,

                            scale:
                              0.98,

                            pointerEvents:
                              "none",
                          }
                    }

                    transition={{
                      duration:
                        0.18,
                    }}

                    className={cn(
                      "z-[200] w-[330px] origin-bottom-right rounded-[16px] border p-2 shadow-[0_18px_55px_rgba(0,0,0,0.18)]",

                      theme === "dark"
                        ? "border-white/[0.09] bg-[#181818] text-white"
                        : "border-black/[0.10] bg-white text-zinc-900",
                    )}
                  >
                    {/* MODELS */}

                    <div className="space-y-1">
                      {availableModels.map(
                        (
                          item,
                        ) => {
                          const selected =
                            item.id ===
                              model &&
                            chatMode ===
                              "normal";

                          return (
                            <button
                              key={
                                item.id
                              }

                              type="button"

                              onClick={() => {
                                onModelChange(
                                  item.id,
                                );

                                changeChatMode(
                                  "normal",
                                );

                                setModelOpen(
                                  false,
                                );
                              }}

                              className={cn(
                                "flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 text-left transition-colors",

                                selected
                                  ? theme ===
                                    "dark"
                                    ? "bg-white/[0.09]"
                                    : "bg-black/[0.065]"
                                  : theme ===
                                    "dark"
                                    ? "hover:bg-white/[0.055]"
                                    : "hover:bg-black/[0.045]",
                              )}
                            >
                              <div className="min-w-0 flex-1">
                                <p
                                  className={cn(
                                    "truncate text-[13px] font-medium",

                                    theme === "dark"
                                      ? "text-zinc-100"
                                      : "text-zinc-900",
                                  )}
                                >
                                  {
                                    item.label
                                  }
                                </p>

                                <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                                  {
                                    item.description
                                  }
                                </p>
                              </div>

                              {selected ? (
                                <Check
                                  size={
                                    16
                                  }
                                  className="shrink-0"
                                />
                              ) : null}
                            </button>
                          );
                        },
                      )}
                    </div>

                    {/* SEPARATOR */}

                    <div
                      className={cn(
                        "mx-2 my-2 border-t",

                        theme === "dark"
                          ? "border-white/[0.08]"
                          : "border-black/[0.08]",
                      )}
                    />

                    {/* RESEARCH */}

                    <button
                      type="button"

                      onClick={() => {
                        changeChatMode(
                          chatMode ===
                            "research"
                            ? "normal"
                            : "research",
                        );

                        setModelOpen(
                          false,
                        );
                      }}

                      className={cn(
                        "flex w-full items-center gap-3 rounded-[11px] px-3 py-3 text-left transition-colors",

                        chatMode ===
                        "research"
                          ? theme ===
                            "dark"
                            ? "bg-white/[0.09]"
                            : "bg-black/[0.065]"
                          : theme ===
                            "dark"
                            ? "hover:bg-white/[0.055]"
                            : "hover:bg-black/[0.045]",
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]",

                          theme === "dark"
                            ? "bg-white/[0.06]"
                            : "bg-black/[0.05]",
                        )}
                      >
                        <Telescope
                          size={
                            16
                          }
                        />
                      </div>

                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "text-[13px] font-medium",

                            theme === "dark"
                              ? "text-zinc-100"
                              : "text-zinc-900",
                          )}
                        >
                          Research mode
                        </p>

                        <p className="mt-0.5 text-[11px] text-zinc-500">
                          Deeper web research and source checking
                        </p>
                      </div>

                      {chatMode ===
                      "research" ? (
                        <Check
                          size={
                            16
                          }
                        />
                      ) : null}
                    </button>
                  </motion.div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {/* MIC */}

            <TooltipButton
              label={
                isRecording
                  ? "Stop dictation"
                  : "Dictate"
              }
              theme={
                theme
              }
            >
              <motion.button
                type="button"

                whileTap={{
                  scale:
                    0.94,
                }}

                onClick={() => {
                  if (
                    isRecording
                  ) {
                    stopVoiceRecording();

                    return;
                  }

                  startVoiceRecording();
                }}

                aria-label={
                  isRecording
                    ? "Stop dictation"
                    : "Dictate"
                }

                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",

                  isRecording
                    ? theme ===
                      "dark"
                      ? "bg-white text-black"
                      : "bg-black text-white"
                    : theme ===
                      "dark"
                      ? "text-zinc-300 hover:bg-white/[0.07] hover:text-white"
                      : "text-zinc-600 hover:bg-black/[0.055] hover:text-black",
                )}
              >
                <Mic
                  size={
                    19
                  }
                  className={
                    isRecording
                      ? "animate-pulse"
                      : ""
                  }
                />
              </motion.button>
            </TooltipButton>

            {/* SEND */}

            {canSend ? (
              <motion.button
                type="button"

                initial={{
                  opacity:
                    0,

                  scale:
                    0.85,
                }}

                animate={{
                  opacity:
                    1,

                  scale:
                    1,
                }}

                whileTap={{
                  scale:
                    0.93,
                }}

                disabled={
                  loading
                }

                onClick={() =>
                  void send()
                }

                aria-label="Send"

                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-opacity disabled:cursor-not-allowed disabled:opacity-50",

                  theme === "dark"
                    ? "bg-white text-black"
                    : "bg-black text-white",
                )}
              >
                <ArrowUp
                  size={
                    18
                  }
                  strokeWidth={
                    2.2
                  }
                />
              </motion.button>
            ) : null}
          </div>
        </div>

        {/* ============================================= */}
        {/* VOICE NOTICE                                  */}
        {/* ============================================= */}

        {voiceNotice ||
        isRecording ? (
          <div
            className={cn(
              "px-5 pb-3 text-[11px]",

              theme === "dark"
                ? "text-zinc-500"
                : "text-zinc-500",
            )}
          >
            {isRecording
              ? "Listening..."
              : voiceNotice}
          </div>
        ) : null}

        {/* ============================================= */}
        {/* FILE INPUT                                    */}
        {/* ============================================= */}

        <input
          ref={
            fileInputRef
          }

          type="file"

          multiple

          accept=".pdf,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv,image/png,image/jpeg,image/webp"

          className="hidden"

          onChange={(
            event,
          ) => {
            void addFiles(
              event.target.files,
            );

            event.currentTarget.value =
              "";
          }}
        />
      </motion.div>
    </div>
  );
}

/* ====================================================== */
/* TOOLTIP                                                */
/* ====================================================== */

function TooltipButton({
  label,
  theme,
  children,
}: {
  label:
    string;

  theme:
    Theme;

  children:
    ReactNode;
}) {
  return (
    <div className="group relative shrink-0">
      {children}

      <div
        className={cn(
          "pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-[300] -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-[8px] border px-2.5 py-1.5 text-[11px] font-medium opacity-0 shadow-lg transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100",

          theme === "dark"
            ? "border-white/[0.09] bg-[#181818] text-white"
            : "border-black/[0.10] bg-white text-[#171717]",
        )}
      >
        {label}
      </div>
    </div>
  );
}