
"use client";

import * as Popover from "@radix-ui/react-popover";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import { motion } from "framer-motion";

import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Mic,
  Paperclip,
  Plus,
  Square,
  Telescope,
  Upload,
  X,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
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

import {
  MODELS,
  confirmModelSelection,
  imageSelectionError,
} from "@/lib/models";

import { useModels } from "@/hooks/useModels";
import ModelChoices from "@/components/layout/ModelChoices";
import LibraryPicker from "@/components/library/LibraryPicker";

import { saveLibraryFile } from "@/lib/library";

import {
  saveChatAttachmentPreview,
} from "@/lib/chatAttachmentPreviews";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type AttachmentKind = "document" | "image";
type AttachmentStatus = "uploading" | "ready" | "error";

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
  localPreview?: string;
}

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

  onModelChange: (model: string) => void;

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

interface RecognitionEvent {
  results: ArrayLike<{
    0: {
      transcript: string;
      isFinal?: boolean;
    };
  }>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
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

const EMPTY_LEVELS = [4, 4, 4, 4, 4, 4, 4];

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function classifyFile(file: File): AttachmentKind | null {
  const name = file.name.toLowerCase();
  const mimeType = file.type.toLowerCase();

  if (
    mimeType.startsWith("image/") ||
    /\.(png|jpg|jpeg|webp)$/i.test(name)
  ) {
    return "image";
  }

  if (
    acceptedExtensions.some((extension) =>
      name.endsWith(extension),
    ) ||
    acceptedMimeTypes.has(mimeType)
  ) {
    return "document";
  }

  return null;
}

function normalizeUploadFile(file: File): File {
  if (/\.[a-z0-9]+$/i.test(file.name)) return file;

  const extension = mimeExtensionMap[file.type.toLowerCase()];

  if (!extension) return file;

  return new File(
    [file],
    `${file.name}.${extension}`,
    {
      type: file.type,
      lastModified: file.lastModified,
    },
  );
}

function containsFiles(
  event: DragEvent<HTMLDivElement>,
): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

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
  const availableModels = useModels();

  const [message, setMessage] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryNotice, setLibraryNotice] = useState("");

  const [chatMode, setChatMode] = useState<ChatMode>(
    () => getActiveChatMode(),
  );

  const [attachments, setAttachments] =
    useState<AttachmentItem[]>([]);

  const [isRecording, setIsRecording] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [voiceNotice, setVoiceNotice] =
    useState<string | null>(null);

  const [audioLevels, setAudioLevels] =
    useState<number[]>(EMPTY_LEVELS);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const dragDepthRef = useRef(0);
  const attachmentsRef = useRef<AttachmentItem[]>([]);

  const voiceBaseMessageRef = useRef("");
  const voiceTranscriptRef = useRef("");

  const uploadAbortersRef = useRef(
    new Map<
      string,
      {
        abort: () => void;
        promise: Promise<unknown>;
      }
    >(),
  );

  const imagePreviewsRef = useRef(new Map<string, string>());

  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioFrameRef = useRef<number | null>(null);
  const audioGenerationRef = useRef(0);

  /* ==================================================== */
  /* INITIAL FOCUS AND PREFILL                            */
  /* ==================================================== */

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
      textarea.setSelectionRange(
        prefill.text.length,
        prefill.text.length,
      );
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [prefill]);

  /* ==================================================== */
  /* CHAT MODE                                            */
  /* ==================================================== */

  useEffect(() => {
    function handleModeUpdate(event: Event) {
      const mode = (
        event as CustomEvent<{ mode?: ChatMode }>
      ).detail?.mode;

      if (mode === "normal" || mode === "research") {
        setChatMode(mode);
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

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  /* ==================================================== */
  /* CLEANUP                                              */
  /* ==================================================== */

  useEffect(() => {
    const aborters = uploadAbortersRef.current;
    const previews = imagePreviewsRef.current;

    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;

      audioGenerationRef.current += 1;

      if (audioFrameRef.current !== null) {
        cancelAnimationFrame(audioFrameRef.current);
      }

      audioStreamRef.current
        ?.getTracks()
        .forEach((track) => track.stop());

      void audioContextRef.current?.close();

      aborters.forEach((entry) => entry.abort());
      aborters.clear();

      previews.forEach((url) => URL.revokeObjectURL(url));
      previews.clear();
    };
  }, []);

  /* ==================================================== */
  /* SELECTED MODEL                                       */
  /* ==================================================== */

  const selectedModel = useMemo(
    () =>
      availableModels.find((item) => item.id === model) ??
      availableModels[0] ??
      MODELS[0],
    [model, availableModels],
  );

  const canSend =
    Boolean(message.trim()) ||
    attachments.some(
      (item) =>
        item.status === "ready" &&
        Boolean(item.serverId),
    );

  function changeChatMode(mode: ChatMode) {
    setChatMode(mode);
    setActiveChatMode(mode);

    window.dispatchEvent(
      new CustomEvent("clawbit:chat-mode-updated", {
        detail: { mode },
      }),
    );
  }

  /* ==================================================== */
  /* ATTACHMENT STATE                                     */
  /* ==================================================== */

  function patchAttachment(
    id: string,
    updater: (item: AttachmentItem) => AttachmentItem,
  ) {
    setAttachments((current) =>
      current.map((item) =>
        item.id === id ? updater(item) : item,
      ),
    );
  }

  function revokePreview(id: string) {
    const url = imagePreviewsRef.current.get(id);

    if (!url) return;

    URL.revokeObjectURL(url);
    imagePreviewsRef.current.delete(id);
  }

  function removeAttachment(id: string) {
    uploadAbortersRef.current.get(id)?.abort();
    uploadAbortersRef.current.delete(id);

    revokePreview(id);

    setAttachments((current) =>
      current.filter((item) => item.id !== id),
    );
  }

  /* ==================================================== */
  /* FILE UPLOAD                                          */
  /* ==================================================== */

  async function addFiles(
    list: FileList | File[] | null,
    saveToLibrary = true,
  ) {
    if (!list?.length) return;

    for (const file of Array.from(list)) {
      const kind = classifyFile(file);

      const imageError = imageSelectionError(
        selectedModel,
        file,
      );

      if (imageError) {
        window.alert(imageError);
        continue;
      }

      const uploadFile = normalizeUploadFile(file);
      const localId = crypto.randomUUID();

      if (!kind) {
        setAttachments((current) => [
          {
            id: localId,
            kind: "document",
            name: file.name,
            detail: `Unsupported file · ${formatBytes(file.size)}`,
            size: file.size,
            mimeType: file.type || "",
            status: "error",
            progress: 0,
            error:
              "Unsupported file type. Upload PDF, DOCX, TXT, MD, CSV, or images.",
          },
          ...current,
        ]);

        continue;
      }

      const localPreview =
        kind === "image"
          ? URL.createObjectURL(file)
          : undefined;

      if (localPreview) {
        imagePreviewsRef.current.set(
          localId,
          localPreview,
        );
      }

      setAttachments((current) => [
        {
          id: localId,
          kind,
          name: file.name,
          detail: `${
            kind === "image" ? "Image" : "Document"
          } · ${formatBytes(file.size)}`,
          size: file.size,
          mimeType: file.type || "",
          status: "uploading",
          progress: 0,
          localPreview,
        },
        ...current,
      ]);

      const uploader = uploadAttachment(
        threadId,
        uploadFile,
        {
          onProgress: (progress) => {
            patchAttachment(localId, (item) => ({
              ...item,
              progress,
            }));
          },
        },
      );

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
            detail: `${
              item.kind === "image" ? "Image" : "Document"
            } · ${formatBytes(item.size)}`,
          }));

          /*
           * Keep a compressed image preview for sent
           * messages, keyed by backend attachment ID.
           */
          void saveChatAttachmentPreview(
            response.attachment_id,
            uploadFile,
            kind,
          ).catch(() => {
            setLibraryNotice(
              "File uploaded, but its chat preview could not be saved in this browser.",
            );
          });

          /*
           * Preserve Library storage. Reused files are
           * not added to Library a second time.
           */
          if (saveToLibrary) {
            void saveLibraryFile(uploadFile)
              .then(() => {
                window.dispatchEvent(
                  new Event("clawbit-library-updated"),
                );
              })
              .catch(() => {
                setLibraryNotice(
                  "File uploaded, but browser storage could not save a Library copy.",
                );
              });
          }
        })
        .catch((error: Error) => {
          patchAttachment(localId, (item) => ({
            ...item,
            error:
              error.message ||
              "Upload failed. Please try again.",
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
      .map(
        (item) =>
          uploadAbortersRef.current.get(item.id)?.promise,
      )
      .filter(
        (promise): promise is Promise<unknown> =>
          Boolean(promise),
      );

    if (pending.length) {
      await Promise.allSettled(pending);
    }
  }

  /* ==================================================== */
  /* DRAG AND DROP                                        */
  /* ==================================================== */

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!containsFiles(event)) return;

    event.preventDefault();

    dragDepthRef.current = 0;
    setIsDragging(false);

    await addFiles(event.dataTransfer.files);
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!containsFiles(event)) return;

    event.preventDefault();
    dragDepthRef.current += 1;

    setIsDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!containsFiles(event)) return;

    event.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!containsFiles(event)) return;

    event.preventDefault();

    dragDepthRef.current = Math.max(
      0,
      dragDepthRef.current - 1,
    );

    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  }

  /* ==================================================== */
  /* SCREENSHOT PASTE                                     */
  /* ==================================================== */

  function handlePaste(
    event: ClipboardEvent<HTMLTextAreaElement>,
  ) {
    const files = Array.from(event.clipboardData.items)
      .filter(
        (item) =>
          item.kind === "file" &&
          item.type.startsWith("image/"),
      )
      .map((item) => item.getAsFile())
      .filter(
        (file): file is File => file !== null,
      );

    if (!files.length) return;

    event.preventDefault();

    const timestamp = Date.now();

    const images = files.map((file, index) => {
      const extension =
        mimeExtensionMap[file.type] ?? "png";

      return new File(
        [file],
        `Screenshot-${timestamp}-${index + 1}.${extension}`,
        {
          type: file.type,
          lastModified: timestamp,
        },
      );
    });

    void addFiles(images);
  }

  /* ==================================================== */
  /* MICROPHONE LEVELS                                    */
  /* ==================================================== */

  function stopAudioMeter() {
    audioGenerationRef.current += 1;

    if (audioFrameRef.current !== null) {
      cancelAnimationFrame(audioFrameRef.current);
      audioFrameRef.current = null;
    }

    audioStreamRef.current
      ?.getTracks()
      .forEach((track) => track.stop());

    audioStreamRef.current = null;

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setAudioLevels(EMPTY_LEVELS);
  }

  async function startAudioMeter() {
    const generation = ++audioGenerationRef.current;

    if (!navigator.mediaDevices?.getUserMedia) return;

    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

      if (generation !== audioGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const context = new AudioContext();
      void context.resume();

      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();

      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.65;

      source.connect(analyser);

      audioStreamRef.current = stream;
      audioContextRef.current = context;

      const samples = new Uint8Array(
        analyser.frequencyBinCount,
      );

      let lastUpdate = 0;

      const draw = (time: number) => {
        if (generation !== audioGenerationRef.current) {
          return;
        }

        if (time - lastUpdate >= 50) {
          analyser.getByteTimeDomainData(samples);

          const chunk = Math.floor(
            samples.length / EMPTY_LEVELS.length,
          );

          const levels = EMPTY_LEVELS.map((_, index) => {
            let sum = 0;

            for (
              let i = index * chunk;
              i < (index + 1) * chunk;
              i += 1
            ) {
              const amplitude = (samples[i] - 128) / 128;
              sum += amplitude * amplitude;
            }

            const rms = Math.sqrt(sum / chunk);

            return Math.max(
              4,
              Math.min(24, Math.round(rms * 150)),
            );
          });

          setAudioLevels(levels);
          lastUpdate = time;
        }

        audioFrameRef.current =
          requestAnimationFrame(draw);
      };

      audioFrameRef.current =
        requestAnimationFrame(draw);
    } catch {
      setAudioLevels(EMPTY_LEVELS);
    }
  }

  /* ==================================================== */
  /* VOICE DICTATION                                      */
  /* ==================================================== */

  function stopVoiceRecording() {
    recognitionRef.current?.stop();
  }

  function finalizeVoicePrompt() {
    const finalText = voiceTranscriptRef.current.trim();

    recognitionRef.current = null;
    setIsRecording(false);

    stopAudioMeter();

    if (finalText) {
      setMessage(finalText);
    }
  }

  function startVoiceRecording() {
    const recognitionWindow = window as Window & {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };

    const Recognition =
      recognitionWindow.SpeechRecognition ??
      recognitionWindow.webkitSpeechRecognition;

    if (!Recognition) {
      setVoiceNotice(
        "Voice input is not supported in this browser. Try Chrome or Edge.",
      );
      return;
    }

    if (recognitionRef.current) {
      stopVoiceRecording();
      return;
    }

    const recognition = new Recognition();

    voiceBaseMessageRef.current = message;
    voiceTranscriptRef.current = message.trim();

    setVoiceNotice(null);

    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => {
      setIsRecording(true);
      void startAudioMeter();
    };

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();

      const text = [
        voiceBaseMessageRef.current.trim(),
        transcript,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();

      voiceTranscriptRef.current = text;
      setMessage(text);
    };

    recognition.onend = () => {
      finalizeVoicePrompt();
    };

    recognition.onerror = (event) => {
      recognitionRef.current = null;
      setIsRecording(false);

      stopAudioMeter();

      voiceTranscriptRef.current =
        voiceBaseMessageRef.current;

      setVoiceNotice(
        event.error === "not-allowed" ||
          event.error === "service-not-allowed"
          ? "Microphone access was denied. Please allow access and try again."
          : "Voice input stopped unexpectedly. Please try again.",
      );
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsRecording(false);

      stopAudioMeter();

      setVoiceNotice(
        "Voice input could not start in this browser.",
      );
    }
  }

  /* ==================================================== */
  /* SEND MESSAGE                                         */
  /* ==================================================== */

  async function send(overrideMessage?: string) {
    if (loading) return;

    if (!selectedModel.available) {
      window.alert(selectedModel.reason);
      return;
    }

    if (!confirmModelSelection(selectedModel)) {
      return;
    }

    if (
      attachmentsRef.current.some(
        (item) => item.kind === "image",
      ) &&
      !selectedModel.capabilities.vision
    ) {
      window.alert(
        "Choose a vision-capable model for the attached images.",
      );
      return;
    }

    await waitForUploads();

    const readyAttachments = attachmentsRef.current
      .filter(
        (item) =>
          item.status === "ready" &&
          Boolean(item.serverId),
      )
      .map((item) => ({
        id: item.serverId!,
        name: item.name,
        size: item.size,
        mimeType: item.mimeType,
        detail: item.detail,
        preview: item.preview,
        kind: item.kind,
      }));

    const readyAttachmentIds = readyAttachments.map(
      (item) => item.id,
    );

    const trimmed = (
      overrideMessage ?? message
    ).trim();

    if (!trimmed && !readyAttachmentIds.length) {
      return;
    }

    onAttachmentsCommitted?.(readyAttachments);

    setMessage("");
    setAttachments([]);
    setVoiceNotice(null);

    imagePreviewsRef.current.forEach((url) => {
      URL.revokeObjectURL(url);
    });

    imagePreviewsRef.current.clear();

    await onSend(trimmed, readyAttachmentIds);
  }

  /* ==================================================== */
  /* COMPOSER UI                                          */
  /* ==================================================== */

  const isDark = theme === "dark";

  return (
    <div className="px-5 pb-5 pt-2 lg:px-8">
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => void handleDrop(event)}
        className={cn(
          "mx-auto max-w-[860px] overflow-visible rounded-[26px] border transition-colors",
          isDark
            ? "border-white/[0.09] bg-[#202020]"
            : "border-black/[0.10] bg-white",
          isDragging
            ? isDark
              ? "ring-2 ring-white/[0.18]"
              : "ring-2 ring-black/[0.14]"
            : "",
        )}
      >
        {/* ATTACHMENT PREVIEWS */}

        {attachments.length > 0 && (
          <div className="px-4 pb-1 pt-3">
            <div className="flex flex-wrap gap-2">
              {attachments.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "flex max-w-[300px] items-center gap-2 rounded-xl border px-3 py-2",
                    item.status === "error"
                      ? isDark
                        ? "border-red-500/30 bg-red-500/[0.08] text-red-100"
                        : "border-red-200 bg-red-50 text-red-900"
                      : isDark
                        ? "border-white/[0.08] bg-[#292929] text-zinc-100"
                        : "border-black/[0.09] bg-[#f7f7f7] text-zinc-900",
                  )}
                >
                  {item.kind === "image" &&
                  (item.localPreview || item.preview) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.localPreview ?? item.preview}
                      alt={item.name}
                      className="h-11 w-11 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <Paperclip
                      size={14}
                      className="shrink-0 text-zinc-500"
                    />
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-medium">
                      {item.name}
                    </p>

                    <p
                      className={cn(
                        "mt-0.5 truncate text-[9px]",
                        item.status === "error"
                          ? "text-red-400"
                          : "text-zinc-500",
                      )}
                    >
                      {item.status === "uploading"
                        ? `Uploading ${item.progress}%`
                        : item.status === "error"
                          ? item.error ?? "Upload failed"
                          : item.detail}
                    </p>
                  </div>

                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => removeAttachment(item.id)}
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                      isDark
                        ? "text-zinc-500 hover:bg-white/[0.08] hover:text-white"
                        : "text-zinc-500 hover:bg-black/[0.06] hover:text-black",
                    )}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* COMMAND BAR */}

        <div className="grid min-h-[56px] grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-1 px-2 py-[7px]">
          {/* ADD FILES */}

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <motion.button
                type="button"
                whileTap={{ scale: 0.94 }}
                aria-label="Add files"
                title="Add files"
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full transition-colors",
                  isDark
                    ? "text-zinc-300 hover:bg-white/[0.07] hover:text-white"
                    : "text-zinc-600 hover:bg-black/[0.055] hover:text-black",
                )}
              >
                <Plus size={21} strokeWidth={1.8} />
              </motion.button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={8}
                className="z-[1200] min-w-[210px] rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--surface)] p-1.5 text-[color:var(--foreground)] shadow-2xl"
              >
                <DropdownMenu.Item
                  onSelect={() =>
                    fileInputRef.current?.click()
                  }
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-[12px] outline-none hover:bg-[color:var(--accent-hover)] data-[highlighted]:bg-[color:var(--accent-hover)]"
                >
                  <Upload size={16} />
                  Upload files
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  onSelect={() => setLibraryOpen(true)}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-[12px] outline-none hover:bg-[color:var(--accent-hover)] data-[highlighted]:bg-[color:var(--accent-hover)]"
                >
                  <BookOpen size={16} />
                  Add from Library
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          {/* TEXT AREA */}

          <TextareaAutosize
            ref={textareaRef}
            minRows={1}
            maxRows={6}
            value={message}
            placeholder={`Ask ${
              assistantName.trim() || "Clawbit"
            }`}
            onChange={(event) =>
              setMessage(event.target.value)
            }
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
            className={cn(
              "block w-full min-w-0 resize-none border-0 bg-transparent px-3 py-0 text-[15px] font-normal leading-[24px] tracking-[-0.01em]",
              "outline-none ring-0 shadow-none focus:border-0 focus:outline-none focus:ring-0 focus:shadow-none",
              "focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none",
              isDark
                ? "text-zinc-100 placeholder:text-zinc-500"
                : "text-zinc-900 placeholder:text-zinc-500",
            )}
            style={{
              outline: "none",
              border: "none",
              boxShadow: "none",
              userSelect: "text",
            }}
          />

          {/* RIGHT CONTROLS */}

          <div className="flex h-10 shrink-0 items-center gap-0.5">
            {/* MODEL SELECTOR */}

            <Popover.Root
              open={modelOpen}
              onOpenChange={setModelOpen}
            >
              <Popover.Trigger asChild>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.97 }}
                  aria-label="Choose model and chat mode"
                  className={cn(
                    "flex h-9 max-w-[215px] shrink-0 items-center gap-1.5 rounded-[10px] border border-transparent px-2.5 text-[12px] font-medium transition-colors",
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
                  {chatMode === "research" && (
                    <Telescope size={14} className="shrink-0" />
                  )}

                  <span className="max-w-[165px] truncate">
                    {selectedModel.label}
                  </span>

                  <motion.span
                    animate={{ rotate: modelOpen ? 180 : 0 }}
                    transition={{ duration: 0.18 }}
                  >
                    <ChevronDown
                      size={13}
                      className="text-zinc-500"
                    />
                  </motion.span>
                </motion.button>
              </Popover.Trigger>

              {/*
               * FIX:
               * Do not force-mount the Radix portal.
               *
               * Previously, the closed popover left a
               * floating data-radix-popper-content-wrapper
               * over chat messages. The invisible wrapper
               * intercepted clicks on Copy, Edit, Cancel,
               * and Save & Regenerate.
               *
               * With normal mounting, the entire wrapper
               * is removed when the selector closes.
               */}
              <Popover.Portal>
                <Popover.Content
                  side="top"
                  align="end"
                  sideOffset={10}
                  asChild
                >
                  <motion.div
                    initial={false}
                    animate={{
                      opacity: 1,
                      y: 0,
                      scale: 1,
                    }}
                    transition={{ duration: 0.18 }}
                    className={cn(
                      "z-[200] w-[330px] origin-bottom-right rounded-[16px] border p-2 shadow-[0_18px_55px_rgba(0,0,0,0.18)]",
                      isDark
                        ? "border-white/[0.09] bg-[#181818] text-white"
                        : "border-black/[0.10] bg-white text-zinc-900",
                    )}
                  >
                    <ModelChoices
                      models={availableModels}
                      selected={model}
                      onSelect={(id) => {
                        onModelChange(id);
                        changeChatMode("normal");
                        setModelOpen(false);
                      }}
                    />

                    <div
                      className={cn(
                        "mx-2 my-2 border-t",
                        isDark
                          ? "border-white/[0.08]"
                          : "border-black/[0.08]",
                      )}
                    />

                    <button
                      type="button"
                      onClick={() => {
                        changeChatMode(
                          chatMode === "research"
                            ? "normal"
                            : "research",
                        );

                        setModelOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-[11px] px-3 py-3 text-left transition-colors",
                        chatMode === "research"
                          ? isDark
                            ? "bg-white/[0.09]"
                            : "bg-black/[0.065]"
                          : isDark
                            ? "hover:bg-white/[0.055]"
                            : "hover:bg-black/[0.045]",
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]",
                          isDark
                            ? "bg-white/[0.06]"
                            : "bg-black/[0.05]",
                        )}
                      >
                        <Telescope size={16} />
                      </div>

                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "text-[13px] font-medium",
                            isDark
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

                      {chatMode === "research" && (
                        <Check size={16} />
                      )}
                    </button>
                  </motion.div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {/* VOICE DICTATION */}

            {isRecording ? (
              <div
                role="status"
                aria-label="Dictation active"
                className={cn(
                  "ml-1 flex h-9 items-center gap-2 rounded-full border px-3",
                  isDark
                    ? "border-white/[0.15] bg-[#2a2a2a] text-zinc-100"
                    : "border-black/[0.12] bg-zinc-100 text-zinc-900",
                )}
              >
                <div
                  aria-hidden="true"
                  className="flex h-6 items-center gap-[3px]"
                >
                  {audioLevels.map((height, index) => (
                    <span
                      key={index}
                      className="w-[3px] rounded-full bg-current transition-[height] duration-75"
                      style={{ height }}
                    />
                  ))}
                </div>

                <button
                  type="button"
                  title="Stop dictation"
                  aria-label="Stop dictation"
                  onClick={stopVoiceRecording}
                  className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-white/10"
                >
                  <Square
                    size={12}
                    fill="currentColor"
                  />
                </button>
              </div>
            ) : (
              <TooltipButton label="Dictate" theme={theme}>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onClick={startVoiceRecording}
                  aria-label="Dictate"
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",
                    isDark
                      ? "text-zinc-300 hover:bg-white/[0.07] hover:text-white"
                      : "text-zinc-600 hover:bg-black/[0.055] hover:text-black",
                  )}
                >
                  <Mic size={19} />
                </motion.button>
              </TooltipButton>
            )}

            {/* SEND */}

            {canSend && (
              <motion.button
                type="button"
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                whileTap={{ scale: 0.93 }}
                disabled={loading}
                onClick={() => void send()}
                aria-label="Send"
                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-50",
                  isDark
                    ? "bg-white text-black"
                    : "bg-black text-white",
                )}
              >
                <ArrowUp size={18} strokeWidth={2.2} />
              </motion.button>
            )}
          </div>
        </div>

        {/* STORAGE AND VOICE NOTICES */}

        {libraryNotice && (
          <p
            role="status"
            className="px-5 pb-3 text-[11px] text-amber-500"
          >
            {libraryNotice}
          </p>
        )}

        {(voiceNotice || isRecording) && (
          <p
            role="status"
            className="px-5 pb-3 text-[11px] text-zinc-500"
          >
            {isRecording ? "Listening..." : voiceNotice}
          </p>
        )}

        {/* NATIVE FILE INPUT */}

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
      </div>

      <LibraryPicker
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        onAttach={(files) => {
          void addFiles(files, false);
        }}
      />
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
  label: string;
  theme: Theme;
  children: ReactNode;
}) {
  return (
    <div className="group relative shrink-0">
      {children}

      <div
        className={cn(
          "pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-[300] -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[11px] font-medium opacity-0 shadow-lg transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100",
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
