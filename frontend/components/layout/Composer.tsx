"use client";

import * as Popover from "@radix-ui/react-popover";
import { motion } from "framer-motion";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Mic,
  Paperclip,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import TextareaAutosize from "react-textarea-autosize";

import { uploadAttachment } from "@/lib/api";
import { MODELS } from "@/lib/models";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface ComposerProps {
  loading: boolean;
  model: string;
  threadId: string;
  theme: Theme;
  prefill?: {
    id: number;
    text: string;
  } | null;
  onModelChange: (model: string) => void;
  onSend: (message: string, attachmentIds?: string[]) => Promise<void>;
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

type AttachmentStatus = "uploading" | "ready" | "error";
type AttachmentKind = "document" | "image";

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
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

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

const acceptedMimeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const availableModels = MODELS.filter((item) => item.available);

const mimeExtensionMap: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export default function Composer({
  loading,
  model,
  threadId,
  theme,
  prefill,
  onModelChange,
  onSend,
  onAttachmentsCommitted,
}: ComposerProps) {
  const [message, setMessage] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dragDepthRef = useRef(0);
  const attachmentsRef = useRef<AttachmentItem[]>([]);
  const voiceBaseMessageRef = useRef("");
  const voiceTranscriptRef = useRef("");
  const uploadAbortersRef = useRef(
    new Map<string, { abort: () => void; promise: Promise<unknown> }>(),
  );

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!prefill) return;

    queueMicrotask(() => {
      setMessage(prefill.text);
      setVoiceNotice(null);
    });

    const frameId = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;

      if (!textarea) return;

      textarea.focus();
      textarea.setSelectionRange(prefill.text.length, prefill.text.length);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [prefill]);

  useEffect(() => {
    const aborters = uploadAbortersRef.current;

    return () => {
      recognitionRef.current?.abort?.();
      recognitionRef.current = null;

      aborters.forEach((entry) => entry.abort());
      aborters.clear();
    };
  }, []);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const selectedModel = useMemo(() => {
    return (
      availableModels.find((item) => item.id === model) ??
      availableModels[0] ??
      MODELS[0]
    );
  }, [model]);

  const filteredModels = useMemo(() => {
    const query = modelFilter.trim().toLowerCase();
    if (!query) return availableModels;
    return availableModels.filter((item) =>
      [item.label, item.provider, item.description]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [modelFilter]);

  function patchAttachment(id: string, updater: (item: AttachmentItem) => AttachmentItem) {
    setAttachments((current) =>
      current.map((item) => (item.id === id ? updater(item) : item)),
    );
  }

  function removeAttachment(id: string) {
    uploadAbortersRef.current.get(id)?.abort();
    uploadAbortersRef.current.delete(id);
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  function normalizeUploadFile(file: File) {
    if (/\.[a-z0-9]+$/i.test(file.name)) {
      return file;
    }

    const extension = mimeExtensionMap[file.type.toLowerCase()];

    if (!extension) {
      return file;
    }

    return new File([file], `${file.name}.${extension}`, {
      type: file.type,
      lastModified: file.lastModified,
    });
  }

  function stopVoiceRecording() {
    recognitionRef.current?.stop?.();
  }

  function finalizeVoicePrompt() {
    const finalText = voiceTranscriptRef.current.trim();

    recognitionRef.current = null;
    setIsRecording(false);
    if (finalText) {
      setMessage(finalText);
    }
  }

  function startVoiceRecording() {
    const recognitionWindow = window as Window & {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const SpeechRecognition =
      recognitionWindow.SpeechRecognition ??
      recognitionWindow.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setVoiceNotice(
        "Voice input is not supported in this browser. Try Chrome or Edge.",
      );
      return;
    }

    if (recognitionRef.current) {
      stopVoiceRecording();
      return;
    }

    const recognition = new SpeechRecognition();
    voiceBaseMessageRef.current = message;
    voiceTranscriptRef.current = message.trim();
    setVoiceNotice(null);
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => {
      setIsRecording(true);
    };

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();

      const combinedText = [voiceBaseMessageRef.current.trim(), transcript]
        .filter(Boolean)
        .join(" ")
        .trim();

      voiceTranscriptRef.current = combinedText;
      setMessage(combinedText);
      textareaRef.current?.focus();
    };

    recognition.onend = () => {
      finalizeVoicePrompt();
    };

    recognition.onerror = (event) => {
      recognitionRef.current = null;
      setIsRecording(false);
      voiceTranscriptRef.current = voiceBaseMessageRef.current;

      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setVoiceNotice(
          "Microphone access was denied. Please allow access and try again.",
        );
      } else {
        setVoiceNotice("Voice input stopped unexpectedly. Please try again.");
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsRecording(false);
      setVoiceNotice("Voice input could not start in this browser.");
    }
  }

  function formatBytes(size: number) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function classifyFile(file: File): AttachmentKind | null {
    const lowerName = file.name.toLowerCase();
    const mimeType = file.type.toLowerCase();

    const isDocument =
      acceptedExtensions.some((ext) => lowerName.endsWith(ext)) &&
      !mimeType.startsWith("image/");

    const isImage =
      mimeType.startsWith("image/") ||
      /\.(png|jpg|jpeg|webp)$/i.test(file.name);

    if (isImage) return "image";
    if (isDocument) return "document";

    if (acceptedMimeTypes.has(mimeType)) {
      return mimeType.startsWith("image/") ? "image" : "document";
    }

    return null;
  }

  function summarizeFile(file: File, kind: AttachmentKind) {
    return {
      detail: `${kind === "image" ? "Image" : "Document"} - ${formatBytes(file.size)}`,
      kind,
      mimeType: file.type || "",
      name: file.name,
      size: file.size,
    };
  }

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;

    const files = Array.from(list);

    for (const file of files) {
      const kind = classifyFile(file);
      const uploadFile = normalizeUploadFile(file);
      const localId = crypto.randomUUID();

      if (!kind) {
        setAttachments((current) => [
          {
            id: localId,
            kind: "document",
            name: file.name,
            detail: `Unsupported file type - ${formatBytes(file.size)}`,
            size: file.size,
            mimeType: file.type || "",
            status: "error",
            progress: 0,
            error: "Unsupported file type. Upload PDF, DOCX, TXT, MD, CSV, or images.",
          },
          ...current,
        ]);
        continue;
      }

      const summary = summarizeFile(file, kind);

      setAttachments((current) => [
        {
          id: localId,
          ...summary,
          status: "uploading",
          progress: 0,
        },
        ...current,
      ]);

      const uploader = uploadAttachment(threadId, uploadFile, {
        onProgress: (progress) => {
          patchAttachment(localId, (item) => ({
            ...item,
            progress,
          }));
        },
      });

      uploadAbortersRef.current.set(localId, uploader);

      uploader.promise
        .then((response) => {
          patchAttachment(localId, (item) => ({
            ...item,
            serverId: response.attachment_id,
            preview: response.preview,
            progress: 100,
            status: "ready",
            mimeType: response.mime_type || item.mimeType,
            detail: `${item.kind === "image" ? "Image" : "Document"} - ${formatBytes(item.size)}`,
          }));
        })
        .catch((error: Error) => {
          patchAttachment(localId, (item) => ({
            ...item,
            error: error.message || "Upload failed. Please try again.",
            status: "error",
          }));
        })
        .finally(() => {
          uploadAbortersRef.current.delete(localId);
        });
    }
  }

  async function waitForUploads() {
    const pending = attachmentsRef.current
      .map((item) => uploadAbortersRef.current.get(item.id)?.promise)
      .filter((promise): promise is Promise<unknown> => Boolean(promise));

    if (pending.length === 0) return;

    await Promise.allSettled(pending);
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    await addFiles(event.dataTransfer.files);
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragging(false);
    }
  }

  async function send(overrideMessage?: string) {
    if (loading) return;

    await waitForUploads();

    const readyAttachmentIds = attachmentsRef.current
      .filter((item) => item.status === "ready" && item.serverId)
      .map((item) => item.serverId as string);
    const readyAttachments = attachmentsRef.current
      .filter((item) => item.status === "ready" && item.serverId)
      .map((item) => ({
        id: item.serverId as string,
        name: item.name,
        size: item.size,
        mimeType: item.mimeType,
        detail: item.detail,
        preview: item.preview,
        kind: item.kind,
      }));

    const trimmed = (overrideMessage ?? message).trim();
    if (!trimmed && readyAttachmentIds.length === 0) return;

    onAttachmentsCommitted?.(readyAttachments);
    setMessage("");
    setAttachments([]);
    setVoiceNotice(null);

    await onSend(trimmed, readyAttachmentIds);
  }

  return (
    <div className="px-5 pb-5 pt-2.5 lg:px-8">
      <motion.div
        layout
        onDragEnter={handleDragEnter}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
            "ui-surface-elevated mx-auto max-w-4xl overflow-hidden border border-[color:var(--border)]/60 dark:rounded-[16px] dark:border-white/[0.04] dark:bg-[#11151b] dark:shadow-none",
          isDragging ? "ring-2 ring-violet-500/30" : "",
          theme === "dark"
            ? "bg-[linear-gradient(180deg,rgba(17,17,22,0.98),rgba(16,16,21,0.98))]"
            : "bg-[linear-gradient(180deg,rgba(249,250,252,0.98),rgba(236,239,244,0.98))]",
        )}
      >
        {attachments.length > 0 ? (
          <div className="border-b border-[color:var(--border)]/70 px-4 pt-3 dark:border-white/[0.04]">
            <div className="flex flex-wrap gap-2">
              {attachments.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "group flex items-center gap-3 rounded-[14px] border px-3 py-2 text-[13px] transition",
                    item.status === "error"
                      ? theme === "dark"
                        ? "border-rose-500/30 bg-rose-500/8 text-rose-200"
                        : "border-rose-400/45 bg-rose-50 text-rose-900"
                      : theme === "dark"
                        ? "border-white/[0.04] bg-[#12161c] text-zinc-200"
                        : "border-slate-300/80 bg-[#f7f8fb] text-slate-800 shadow-[0_8px_20px_rgba(15,23,42,0.06)]",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-[11px]",
                      item.status === "error"
                        ? theme === "dark"
                          ? "bg-rose-500/10 text-rose-300"
                          : "bg-rose-100 text-rose-700"
                        : theme === "dark"
                        ? "bg-[#11151b]"
                          : "bg-slate-200/80 text-slate-700",
                    )}
                  >
                    <Paperclip size={15} />
                  </div>

                  <div className="min-w-0">
                    <p className="max-w-[220px] truncate font-medium leading-5">{item.name}</p>
                    <p
                      className={cn(
                        "text-[11px]",
                        item.status === "error"
                          ? theme === "dark"
                            ? "text-rose-300"
                            : "text-rose-700"
                          : theme === "dark"
                            ? "text-zinc-500"
                            : "text-slate-600",
                      )}
                    >
                      {item.status === "uploading"
                        ? `Uploading ${item.progress}%`
                        : item.status === "error"
                          ? item.error ?? "Upload failed"
                          : item.detail}
                    </p>
                    {item.preview && item.status === "ready" ? (
                      <p
                        className={cn(
                          "mt-1 max-w-[300px] truncate text-[11px]",
                          theme === "dark" ? "text-zinc-500" : "text-slate-500",
                        )}
                      >
                        {item.preview}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2">
                    {item.status === "uploading" ? (
                      <span
                        className={cn(
                          "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]",
                          theme === "dark"
                            ? "bg-[#12161c] text-zinc-300"
                            : "bg-slate-200 text-slate-700",
                        )}
                      >
                        Loading
                      </span>
                    ) : null}

                    <button
                      type="button"
                      title="Remove attachment"
                      onClick={() => removeAttachment(item.id)}
                      className={cn(
                        "rounded-full p-1 opacity-70 transition hover:opacity-100",
                        theme === "dark"
                          ? "hover:bg-white/[0.03]"
                          : "hover:bg-slate-200",
                      )}
                    >
                      x
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <TextareaAutosize
          ref={textareaRef}
          minRows={2}
          maxRows={8}
          value={message}
          placeholder="How can I help you today?"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          className={cn(
            "w-full resize-none bg-transparent px-4 pt-4 text-[14px] leading-6 outline-none shadow-none ring-0 focus:outline-none focus:ring-0 focus:shadow-none focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none",
            theme === "dark"
              ? "text-white placeholder:text-zinc-500"
              : "text-slate-950 placeholder:text-slate-500",
          )}
          style={{ boxShadow: "none" }}
        />

        {voiceNotice || isRecording ? (
          <div
            className={cn(
              "px-4 pt-2 text-[11px]",
              isRecording
                ? "text-violet-500"
                : theme === "dark"
                  ? "text-zinc-400"
                  : "text-slate-500",
            )}
          >
            {isRecording ? "Listening... speak now." : voiceNotice}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3 px-3.5 pb-3.5 pt-3.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              title="Attach files"
              aria-label="Add attachments"
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "ui-icon-button transition hover:-translate-y-px",
                theme === "dark"
                  ? "bg-[color:var(--surface)] text-zinc-300 hover:text-white"
                  : "border-slate-300 bg-slate-100 text-slate-700 hover:border-violet-300 hover:bg-violet-50 hover:text-slate-950",
              )}
            >
              <Paperclip size={18} />
            </button>

            <button
              type="button"
              title={isRecording ? "Stop voice mode" : "Voice mode"}
              aria-label="Voice input"
              aria-pressed={isRecording}
              onClick={() => {
                if (isRecording) {
                  stopVoiceRecording();
                  return;
                }

                startVoiceRecording();
              }}
              className={cn(
                "ui-icon-button transition hover:-translate-y-px",
                theme === "dark"
                  ? "bg-[color:var(--surface)] text-zinc-300 hover:text-white"
                  : "border-slate-300 bg-slate-100 text-slate-700 hover:border-violet-300 hover:bg-violet-50 hover:text-slate-950",
                isRecording
                  ? "border-violet-500/30 bg-violet-500/8 text-violet-500 shadow-[0_0_0_1px_rgba(139,92,246,0.18)]"
                  : "",
              )}
            >
              <Mic className={isRecording ? "animate-pulse" : ""} size={18} />
            </button>
          </div>

          <div className="flex items-center gap-3">
            <Popover.Root open={modelOpen} onOpenChange={setModelOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  title="Model"
                  aria-label="Choose model"
                  className={cn(
                    "inline-flex min-w-[200px] items-center justify-between gap-3 rounded-[16px] border px-3.5 py-2 text-left text-[13px] backdrop-blur-xl transition hover:-translate-y-px",
                    theme === "dark"
                  ? "border-white/[0.04] bg-[#12161c] text-white"
                      : "border-slate-300 bg-slate-100 text-slate-950 hover:border-violet-300 hover:bg-violet-50",
                  )}
                >
                  <span className="inline-flex items-center gap-2">
                    <Search size={15} className="text-violet-500" />
                    <span className="font-medium">{selectedModel.label}</span>
                  </span>
                  <ChevronDown size={15} className="text-zinc-400" />
                </button>
              </Popover.Trigger>

              <Popover.Portal>
                <Popover.Content
                  side="top"
                  align="end"
                  sideOffset={14}
                  className="ui-menu-surface z-50 w-[360px] p-2 text-[color:var(--foreground)]"
                >
                  <div className="px-3 py-2">
                    <p className="text-[14px] font-semibold">Choose model</p>
                    <p className={cn("text-[13px]", theme === "dark" ? "text-zinc-400" : "text-slate-600")}>
                      Choose between available Gemini and Groq models.
                    </p>
                  </div>

                  <div
                    className={cn(
                      "flex items-center gap-3 rounded-[14px] border px-3 py-3",
                      theme === "dark"
                        ? "border-white/[0.04] bg-[#11151b]"
                        : "border-slate-300 bg-slate-100",
                    )}
                  >
                    <Search
                      size={16}
                      className={theme === "dark" ? "text-zinc-500" : "text-slate-500"}
                    />
                    <input
                      value={modelFilter}
                      onChange={(event) => setModelFilter(event.target.value)}
                      placeholder="Search models..."
                      className={cn(
                        "w-full bg-transparent text-[14px] outline-none",
                        theme === "dark"
                          ? "placeholder:text-zinc-500"
                          : "text-slate-950 placeholder:text-slate-500",
                      )}
                    />
                  </div>

                  <div className="mt-2 max-h-[320px] overflow-y-auto">
                    {filteredModels.length === 0 ? (
                      <div className="px-3 py-6 text-[14px] text-zinc-400">
                        No available models found.
                      </div>
                    ) : (
                      filteredModels.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            onModelChange(item.id);
                            setModelOpen(false);
                          }}
                          className={cn(
                            "mt-1 flex w-full items-start justify-between rounded-[14px] px-3 py-3 text-left outline-none transition",
                            theme === "dark"
                              ? "text-white hover:bg-white/[0.03]"
                              : "text-slate-950 hover:bg-violet-50",
                          )}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-[14px] font-medium">{item.label}</p>
                              {item.badge ? (
                                <span
                                  className={cn(
                                    "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]",
                                    item.available
                                      ? "bg-violet-500/12 text-violet-400"
                                      : "bg-slate-200 text-slate-500 dark:bg-white/8 dark:text-zinc-500",
                                  )}
                                >
                                  {item.badge}
                                </span>
                              ) : null}
                            </div>
                            <p className={cn("mt-1 text-xs", theme === "dark" ? "text-zinc-400" : "text-slate-600")}>
                              {item.provider}
                            </p>
                            <p className={cn("mt-1 text-xs leading-5", theme === "dark" ? "text-zinc-500" : "text-slate-600")}>
                              {item.description}
                            </p>
                          </div>
                          {model === item.id ? <Check size={16} className="mt-1 text-violet-500" /> : null}
                        </button>
                      ))
                    )}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <button
              type="button"
              title="Send"
              aria-label="Send message"
              onClick={() => void send()}
              disabled={loading}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-[16px] text-white transition hover:-translate-y-px hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50",
                theme === "dark"
                  ? "bg-gradient-to-r from-violet-600 to-fuchsia-500 shadow-none"
                  : "bg-gradient-to-r from-violet-700 to-fuchsia-600 shadow-[0_12px_26px_rgba(109,40,217,0.22)]",
              )}
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv,image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            void addFiles(event.target.files);
            event.currentTarget.value = "";
          }}
        />
      </motion.div>
    </div>
  );
}
