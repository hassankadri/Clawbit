"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";

import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  Folder,
  Mic,
  Paperclip,
  PlugZap,
  Plus,
  X,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { uploadAttachment } from "@/lib/api";
import { MODELS } from "@/lib/models";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/* ====================================================== */
/* TYPES                                                  */
/* ====================================================== */

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

  name: string;

  size: number;

  mimeType: string;

  kind: AttachmentKind;

  detail: string;

  status: AttachmentStatus;

  progress: number;

  error?: string;
}

interface SpeechRecognitionResultLike {
  transcript: string;
  isFinal?: boolean;
}

interface SpeechRecognitionEventLike {
  results: Array<{
    0: SpeechRecognitionResultLike;
  }>;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;

  interimResults: boolean;

  continuous: boolean;

  onresult:
    | ((
        event: SpeechRecognitionEventLike,
      ) => void)
    | null;

  onend:
    | (() => void)
    | null;

  onerror:
    | ((
        event: SpeechRecognitionErrorEventLike,
      ) => void)
    | null;

  start: () => void;

  stop: () => void;

  abort: () => void;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface UploadedProjectFile {
  id: string;

  name: string;

  size: number;

  mimeType: string;

  detail: string;

  kind: AttachmentKind;
}

interface ProjectCommandBarProps {
  theme: Theme;

  projectId: string;

  projectName: string;

  projects: ProjectOption[];

  loading: boolean;

  model: string;

  threadId: string;

  initialPrompt?: string;

  onModelChange: (
    model: string,
  ) => void;

  onChooseProject: (
    id: string,
  ) => void;

  onOpenFiles: () => void;

  onOpenTools: () => void;

  onFilesUploaded: (
    files: UploadedProjectFile[],
  ) => void;

  onSend: (
    message: string,
    attachmentIds?: string[],
  ) => Promise<void>;
}

/* ====================================================== */
/* CONSTANTS                                              */
/* ====================================================== */

const availableModels =
  MODELS.filter(
    (item) =>
      item.available,
  );

const acceptedFiles =
  ".pdf,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp";

/* ====================================================== */
/* COMPONENT                                              */
/* ====================================================== */

export default function ProjectCommandBar({
  theme,

  projectId,

  projectName,

  projects,

  loading,

  model,

  threadId,

  initialPrompt,

  onModelChange,

  onChooseProject,

  onOpenFiles,

  onOpenTools,

  onFilesUploaded,

  onSend,
}: ProjectCommandBarProps) {
  const isDark =
    theme === "dark";

  const [
    message,
    setMessage,
  ] =
    useState(
      initialPrompt ??
        "",
    );

  const [
    attachments,
    setAttachments,
  ] =
    useState<
      AttachmentItem[]
    >([]);

  const [
    modelOpen,
    setModelOpen,
  ] =
    useState(false);

  const [
    isRecording,
    setIsRecording,
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

  /* ==================================================== */
  /* MODEL                                                */
  /* ==================================================== */

  const selectedModel =
    useMemo(() => {
      return (
        availableModels.find(
          (item) =>
            item.id ===
            model,
        ) ??
        availableModels[0] ??
        MODELS[0]
      );
    }, [
      model,
    ]);

  /* ==================================================== */
  /* SEND STATE                                           */
  /* ==================================================== */

  const readyAttachmentIds =
    attachments
      .filter(
        (item) =>
          item.status ===
            "ready" &&
          Boolean(
            item.serverId,
          ),
      )
      .map(
        (item) =>
          item.serverId!,
      );

  const uploading =
    attachments.some(
      (item) =>
        item.status ===
        "uploading",
    );

  const canSend =
    !loading &&
    !uploading &&
    (
      message
        .trim()
        .length >
        0 ||
      readyAttachmentIds.length >
        0
    );

  /* ==================================================== */
  /* INITIAL PROMPT                                       */
  /* ==================================================== */

  useEffect(() => {
    if (
      initialPrompt ===
      undefined
    ) {
      return;
    }

    setMessage(
      initialPrompt,
    );

    window.requestAnimationFrame(
      () =>
        textareaRef.current?.focus(),
    );
  }, [
    initialPrompt,
  ]);

  /* ==================================================== */
  /* CLEANUP                                              */
  /* ==================================================== */

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();

      recognitionRef.current =
        null;
    };
  }, []);

  /* ==================================================== */
  /* ATTACHMENTS                                          */
  /* ==================================================== */

  function patchAttachment(
    id: string,

    updater: (
      item: AttachmentItem,
    ) => AttachmentItem,
  ) {
    setAttachments(
      (current) =>
        current.map(
          (item) =>
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
    id: string,
  ) {
    setAttachments(
      (current) =>
        current.filter(
          (item) =>
            item.id !==
            id,
        ),
    );
  }

  async function uploadFiles(
    files: FileList | null,
  ) {
    if (
      !files ||
      files.length ===
        0
    ) {
      return;
    }

    const uploadedForProject:
      UploadedProjectFile[] =
      [];

    for (
      const file of
      Array.from(
        files,
      )
    ) {
      const localId =
        crypto.randomUUID();

      const kind:
        AttachmentKind =
        file.type.startsWith(
          "image/",
        )
          ? "image"
          : "document";

      const item:
        AttachmentItem = {
        id:
          localId,

        name:
          file.name,

        size:
          file.size,

        mimeType:
          file.type,

        kind,

        detail:
          formatFileSize(
            file.size,
          ),

        status:
          "uploading",

        progress:
          0,
      };

      setAttachments(
        (current) => [
          ...current,
          item,
        ],
      );

      try {
        const upload =
          uploadAttachment(
            threadId,
            file,
            {
              onProgress: (
                progress,
              ) => {
                patchAttachment(
                  localId,

                  (
                    current,
                  ) => ({
                    ...current,

                    progress,
                  }),
                );
              },
            },
          );

        const result =
          await upload.promise;

        patchAttachment(
          localId,

          (
            current,
          ) => ({
            ...current,

            serverId:
              result.attachment_id,

            name:
              result.name,

            mimeType:
              result.mime_type,

            size:
              result.size,

            kind:
              result.kind as AttachmentKind,

            detail:
              formatFileSize(
                result.size,
              ),

            status:
              "ready",

            progress:
              100,
          }),
        );

        uploadedForProject.push(
          {
            id:
              result.attachment_id,

            name:
              result.name,

            size:
              result.size,

            mimeType:
              result.mime_type,

            kind:
              result.kind as AttachmentKind,

            detail:
              formatFileSize(
                result.size,
              ),
          },
        );
      } catch (
        error
      ) {
        patchAttachment(
          localId,

          (
            current,
          ) => ({
            ...current,

            status:
              "error",

            error:
              error instanceof
              Error
                ? error.message
                : "Upload failed.",
          }),
        );
      }
    }

    if (
      uploadedForProject.length >
      0
    ) {
      onFilesUploaded(
        uploadedForProject,
      );
    }

    if (
      fileInputRef.current
    ) {
      fileInputRef.current.value =
        "";
    }
  }

  /* ==================================================== */
  /* SEND                                                 */
  /* ==================================================== */

  async function submit() {
    if (
      !canSend
    ) {
      return;
    }

    const text =
      message.trim();

    try {
      await onSend(
        text,
        readyAttachmentIds,
      );

      setMessage(
        "",
      );

      setAttachments(
        [],
      );
    } catch {
      /*
       * Keep the message and
       * attachments so the user
       * can retry.
       */
    }
  }

  function handleKeyDown(
    event:
      KeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (
      event.key ===
        "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();

      void submit();
    }
  }

  /* ==================================================== */
  /* VOICE                                                */
  /* ==================================================== */

  function stopVoice() {
    recognitionRef.current?.stop();
  }

  function startVoice() {
    const speechWindow =
      window as Window & {
        SpeechRecognition?:
          new () => SpeechRecognitionLike;

        webkitSpeechRecognition?:
          new () => SpeechRecognitionLike;
      };

    const SpeechRecognition =
      speechWindow.SpeechRecognition ??
      speechWindow.webkitSpeechRecognition;

    if (
      !SpeechRecognition
    ) {
      setVoiceNotice(
        "Voice input works in supported browsers such as Chrome or Edge.",
      );

      return;
    }

    const recognition =
      new SpeechRecognition();

    recognition.lang =
      "en-US";

    recognition.interimResults =
      true;

    recognition.continuous =
      true;

    const baseMessage =
      message.trim();

    recognition.onresult =
      (event) => {
        let transcript =
          "";

        for (
          let index = 0;
          index <
          event.results.length;
          index += 1
        ) {
          transcript +=
            event.results[
              index
            ][0]
              ?.transcript ??
            "";
        }

        const clean =
          transcript.trim();

        if (
          !clean
        ) {
          return;
        }

        setMessage(
          baseMessage
            ? `${baseMessage} ${clean}`
            : clean,
        );
      };

    recognition.onerror =
      (event) => {
        setIsRecording(
          false,
        );

        recognitionRef.current =
          null;

        if (
          event.error !==
          "aborted"
        ) {
          setVoiceNotice(
            "Voice input stopped. Please try again.",
          );
        }
      };

    recognition.onend =
      () => {
        setIsRecording(
          false,
        );

        recognitionRef.current =
          null;
      };

    recognitionRef.current =
      recognition;

    setVoiceNotice(
      null,
    );

    setIsRecording(
      true,
    );

    recognition.start();
  }

  function toggleVoice() {
    if (
      isRecording
    ) {
      stopVoice();

      return;
    }

    startVoice();
  }

  /* ==================================================== */
  /* UI                                                   */
  /* ==================================================== */

  return (
    <div className="w-full">
      {/* FILE INPUT */}

      <input
        ref={
          fileInputRef
        }
        type="file"
        multiple
        accept={
          acceptedFiles
        }
        className="hidden"
        onChange={(
          event,
        ) =>
          void uploadFiles(
            event.target
              .files,
          )
        }
      />

      {/* ============================================= */}
      {/* MAIN COMPOSER                                 */}
      {/* ============================================= */}

      <div
        className={cn(
          "relative z-10 overflow-visible rounded-[28px] border transition-colors",

          isDark
            ? "border-white/[0.09] bg-[#202020]"
            : "border-black/[0.10] bg-white",
        )}
      >
        {/* TEXTAREA */}

        <textarea
          ref={
            textareaRef
          }
          value={
            message
          }
          onChange={(
            event,
          ) =>
            setMessage(
              event.target
                .value,
            )
          }
          onKeyDown={
            handleKeyDown
          }
          rows={
            3
          }
          placeholder={`Work in ${projectName}`}
          className={cn(
            "min-h-[112px] w-full resize-none border-0 bg-transparent px-5 pb-2 pt-5 text-[15px] leading-6 outline-none ring-0 shadow-none",

            "focus:border-0 focus:outline-none focus:ring-0 focus:shadow-none",

            "focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none",

            isDark
              ? "text-white placeholder:text-zinc-500"
              : "text-zinc-900 placeholder:text-zinc-400",
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
        {/* ATTACHMENTS                                 */}
        {/* =========================================== */}

        {attachments.length >
        0 ? (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {attachments.map(
              (
                item,
              ) => (
                <div
                  key={
                    item.id
                  }
                  className={cn(
                    "flex max-w-[240px] items-center gap-2 rounded-[11px] border px-2.5 py-2",

                    item.status ===
                    "error"
                      ? isDark
                        ? "border-red-500/25 bg-red-500/[0.07]"
                        : "border-red-200 bg-red-50"
                      : isDark
                        ? "border-white/[0.07] bg-[#181818]"
                        : "border-black/[0.08] bg-[#f7f7f7]",
                  )}
                >
                  <FileText
                    size={
                      14
                    }
                    className={cn(
                      "shrink-0",

                      item.status ===
                      "error"
                        ? "text-red-500"
                        : "text-zinc-500",
                    )}
                  />

                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "truncate text-[10px]",

                        isDark
                          ? "text-zinc-300"
                          : "text-zinc-800",
                      )}
                    >
                      {
                        item.name
                      }
                    </p>

                    <p
                      className={cn(
                        "mt-0.5 truncate text-[9px]",

                        item.status ===
                        "error"
                          ? isDark
                            ? "text-red-400"
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
                    title="Remove file"
                    onClick={() =>
                      removeAttachment(
                        item.id,
                      )
                    }
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors",

                      isDark
                        ? "hover:bg-white/[0.08] hover:text-white"
                        : "hover:bg-black/[0.06] hover:text-black",
                    )}
                  >
                    <X
                      size={
                        11
                      }
                    />
                  </button>
                </div>
              ),
            )}
          </div>
        ) : null}

        {/* =========================================== */}
        {/* BOTTOM ROW                                  */}
        {/* =========================================== */}

        <div className="flex items-center justify-between gap-3 px-3 pb-3">
          {/* ADD FILE */}

          <button
            type="button"
            onClick={() =>
              fileInputRef.current?.click()
            }
            title="Add files"
            aria-label="Add files"
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",

              isDark
                ? "text-zinc-300 hover:bg-white/[0.07] hover:text-white"
                : "text-zinc-600 hover:bg-black/[0.055] hover:text-black",
            )}
          >
            <Plus
              size={
                20
              }
              strokeWidth={
                1.9
              }
            />
          </button>

          {/* RIGHT SIDE */}

          <div className="flex items-center gap-1">
            {/* ======================================= */}
            {/* MODEL                                   */}
            {/* ======================================= */}

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
                <button
                  type="button"
                  className={cn(
                    "flex h-9 max-w-[210px] items-center gap-1.5 rounded-[10px] border border-transparent px-3 text-[12px] transition-colors",

                    isDark
                      ? "text-zinc-300 hover:bg-white/[0.06] hover:text-white"
                      : "text-zinc-700 hover:bg-black/[0.045] hover:text-black",

                    modelOpen
                      ? isDark
                        ? "bg-white/[0.07]"
                        : "bg-black/[0.05]"
                      : "",
                  )}
                >
                  <span className="truncate">
                    {
                      selectedModel.label
                    }
                  </span>

                  <ChevronDown
                    size={
                      13
                    }
                    className={cn(
                      "shrink-0 transition-transform",

                      modelOpen
                        ? "rotate-180"
                        : "",

                      "text-zinc-500",
                    )}
                  />
                </button>
              </Popover.Trigger>

              <Popover.Portal>
                <Popover.Content
                  side="top"
                  align="end"
                  sideOffset={
                    10
                  }
                  collisionPadding={
                    12
                  }
                  className={cn(
                    "z-[1200] w-[310px] rounded-[17px] border p-2 outline-none shadow-[0_24px_65px_rgba(0,0,0,0.20)]",

                    isDark
                      ? "border-white/[0.09] bg-[#181818] text-white"
                      : "border-black/[0.10] bg-white text-zinc-950",
                  )}
                >
                  {availableModels.map(
                    (
                      item,
                    ) => {
                      const selected =
                        item.id ===
                        model;

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

                            setModelOpen(
                              false,
                            );
                          }}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 text-left transition-colors",

                            selected
                              ? isDark
                                ? "bg-white/[0.085]"
                                : "bg-black/[0.06]"
                              : isDark
                                ? "hover:bg-white/[0.055]"
                                : "hover:bg-black/[0.045]",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <p
                              className={cn(
                                "truncate text-[12px] font-medium",

                                isDark
                                  ? "text-zinc-200"
                                  : "text-zinc-900",
                              )}
                            >
                              {
                                item.label
                              }
                            </p>

                            <p className="mt-0.5 truncate text-[10px] text-zinc-500">
                              {
                                item.description
                              }
                            </p>
                          </div>

                          {selected ? (
                            <Check
                              size={
                                15
                              }
                              className={
                                isDark
                                  ? "text-white"
                                  : "text-black"
                              }
                            />
                          ) : null}
                        </button>
                      );
                    },
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {/* ======================================= */}
            {/* MIC                                     */}
            {/* ======================================= */}

            <button
              type="button"
              onClick={
                toggleVoice
              }
              aria-label={
                isRecording
                  ? "Stop voice input"
                  : "Start voice input"
              }
              title={
                isRecording
                  ? "Stop voice input"
                  : "Voice input"
              }
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-full transition-colors",

                isRecording
                  ? isDark
                    ? "bg-white text-black"
                    : "bg-black text-white"
                  : isDark
                    ? "text-zinc-300 hover:bg-white/[0.07] hover:text-white"
                    : "text-zinc-600 hover:bg-black/[0.055] hover:text-black",
              )}
            >
              <Mic
                size={
                  17
                }
                className={
                  isRecording
                    ? "animate-pulse"
                    : ""
                }
              />
            </button>

            {/* ======================================= */}
            {/* SEND                                    */}
            {/* ======================================= */}

            <button
              type="button"
              disabled={
                !canSend
              }
              onClick={() =>
                void submit()
              }
              title={
                uploading
                  ? "Wait for uploads to finish"
                  : "Send"
              }
              aria-label="Send"
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-full transition-colors",

                canSend
                  ? isDark
                    ? "bg-white text-black hover:bg-zinc-200"
                    : "bg-black text-white hover:bg-zinc-800"
                  : isDark
                    ? "cursor-not-allowed bg-white/[0.08] text-zinc-600"
                    : "cursor-not-allowed bg-black/[0.07] text-zinc-400",
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
            </button>
          </div>
        </div>
      </div>

      {/* ============================================= */}
      {/* PROJECT UTILITY ROW                           */}
      {/* ============================================= */}

      <div
        className={cn(
          "relative z-0 mx-3 -mt-[2px] flex min-h-[48px] items-center rounded-b-[18px] border-x border-b px-2 pt-[3px]",

          isDark
            ? "border-white/[0.055] bg-[#111111]"
            : "border-black/[0.07] bg-[#f4f4f4]",
        )}
      >
        {/* =========================================== */}
        {/* CHOOSE PROJECT                              */}
        {/* =========================================== */}

        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            asChild
          >
            <button
              type="button"
              className={cn(
                "flex h-9 min-w-0 items-center gap-2 rounded-[9px] px-3 text-[12px] transition-colors",

                isDark
                  ? "text-zinc-300 hover:bg-white/[0.06] hover:text-white"
                  : "text-zinc-700 hover:bg-black/[0.05] hover:text-black",
              )}
            >
              <Folder
                size={
                  15
                }
                className="shrink-0 text-zinc-500"
              />

              <span className="max-w-[160px] truncate">
                {
                  projectName
                }
              </span>

              <ChevronDown
                size={
                  12
                }
                className="shrink-0 text-zinc-500"
              />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="start"
              sideOffset={
                6
              }
              collisionPadding={
                12
              }
              className={cn(
                "z-[1200] w-[230px] rounded-[14px] border p-1.5 shadow-[0_20px_55px_rgba(0,0,0,0.18)]",

                isDark
                  ? "border-white/[0.09] bg-[#181818] text-white"
                  : "border-black/[0.10] bg-white text-zinc-950",
              )}
            >
              {projects.map(
                (
                  project,
                ) => {
                  const selected =
                    project.id ===
                    projectId;

                  return (
                    <DropdownMenu.Item
                      key={
                        project.id
                      }
                      onSelect={() =>
                        onChooseProject(
                          project.id,
                        )
                      }
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-[9px] px-3 py-2.5 text-[12px] outline-none transition-colors",

                        selected
                          ? isDark
                            ? "bg-white/[0.08] text-white"
                            : "bg-black/[0.06] text-black"
                          : isDark
                            ? "text-zinc-300 hover:bg-white/[0.06] focus:bg-white/[0.06] data-[highlighted]:bg-white/[0.06]"
                            : "text-zinc-700 hover:bg-black/[0.045] focus:bg-black/[0.045] data-[highlighted]:bg-black/[0.045]",
                      )}
                    >
                      <Folder
                        size={
                          14
                        }
                        className="shrink-0 text-zinc-500"
                      />

                      <span className="min-w-0 flex-1 truncate">
                        {
                          project.name
                        }
                      </span>

                      {selected ? (
                        <Check
                          size={
                            13
                          }
                        />
                      ) : null}
                    </DropdownMenu.Item>
                  );
                },
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {/* =========================================== */}
        {/* FILES                                       */}
        {/* =========================================== */}

        <button
          type="button"
          onClick={
            onOpenFiles
          }
          className={cn(
            "flex h-9 items-center gap-2 rounded-[9px] px-3 text-[12px] transition-colors",

            isDark
              ? "text-zinc-300 hover:bg-white/[0.06] hover:text-white"
              : "text-zinc-700 hover:bg-black/[0.05] hover:text-black",
          )}
        >
          <Paperclip
            size={
              15
            }
            className="text-zinc-500"
          />

          Files
        </button>

        {/* =========================================== */}
        {/* MCP                                         */}
        {/* =========================================== */}

        <button
          type="button"
          onClick={
            onOpenTools
          }
          className={cn(
            "flex h-9 items-center gap-2 rounded-[9px] px-3 text-[12px] transition-colors",

            isDark
              ? "text-zinc-300 hover:bg-white/[0.06] hover:text-white"
              : "text-zinc-700 hover:bg-black/[0.05] hover:text-black",
          )}
        >
          <PlugZap
            size={
              15
            }
            className="text-zinc-500"
          />

          MCP
        </button>
      </div>

      {/* ============================================= */}
      {/* VOICE NOTICE                                  */}
      {/* ============================================= */}

      {voiceNotice ? (
        <p className="mt-2 text-center text-[10px] text-zinc-500">
          {
            voiceNotice
          }
        </p>
      ) : null}
    </div>
  );
}

/* ====================================================== */
/* FORMAT FILE SIZE                                       */
/* ====================================================== */

function formatFileSize(
  bytes: number,
) {
  if (
    bytes <
    1024
  ) {
    return `${bytes} B`;
  }

  const kilobytes =
    bytes /
    1024;

  if (
    kilobytes <
    1024
  ) {
    return `${kilobytes.toFixed(
      1,
    )} KB`;
  }

  const megabytes =
    kilobytes /
    1024;

  return `${megabytes.toFixed(
    1,
  )} MB`;
}