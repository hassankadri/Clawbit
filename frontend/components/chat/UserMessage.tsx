
"use client";

import * as Dialog from "@radix-ui/react-dialog";

import {
  Check,
  Copy,
  FileText,
  ImageIcon,
  Pencil,
  X,
} from "lucide-react";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import UserAvatar from "@/components/common/UserAvatar";

import {
  CHAT_ATTACHMENT_PREVIEW_EVENT,
  getChatAttachmentPreviews,
} from "@/lib/chatAttachmentPreviews";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface Props {
  content: string;
  theme: Theme;
  attachmentIds?: string[];

  onEdit: (
    nextContent: string,
  ) => void | Promise<void>;

  onDelete: () => void;
}

interface DisplayAttachment {
  id: string;
  name: string;
  kind: "image" | "document" | "unknown";
  url?: string;
}

export default function UserMessage({
  content,
  theme,
  attachmentIds = [],
  onEdit,
}: Props) {
  const isDark = theme === "dark";

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const [attachments, setAttachments] =
    useState<DisplayAttachment[]>([]);

  const [selectedImage, setSelectedImage] =
    useState<DisplayAttachment | null>(null);

  const copyTimerRef = useRef<number | null>(null);

  const idsKey = attachmentIds.join("\u001f");

  /* ==================================================== */
  /* ATTACHMENT PREVIEWS                                  */
  /* ==================================================== */

  useEffect(() => {
    const ids = idsKey
      ? idsKey.split("\u001f")
      : [];

    let active = true;
    let generation = 0;
    let ownedUrls: string[] = [];

    async function refresh() {
      const requestGeneration = ++generation;

      if (!ids.length) {
        if (active) {
          setAttachments([]);
        }

        return;
      }

      try {
        const stored =
          await getChatAttachmentPreviews(ids);

        if (
          !active ||
          requestGeneration !== generation
        ) {
          return;
        }

        const byId = new Map(
          stored.map((item) => [
            item.id,
            item,
          ]),
        );

        const nextUrls: string[] = [];

        const next: DisplayAttachment[] =
          ids.map((id) => {
            const record = byId.get(id);

            if (!record) {
              return {
                id,
                name: "Attached file",
                kind: "unknown",
              };
            }

            if (
              record.kind === "image" &&
              record.thumbnail
            ) {
              const url =
                URL.createObjectURL(
                  record.thumbnail,
                );

              nextUrls.push(url);

              return {
                id,
                name: record.name,
                kind: "image",
                url,
              };
            }

            return {
              id,
              name: record.name,
              kind: record.kind,
            };
          });

        ownedUrls.forEach((url) => {
          URL.revokeObjectURL(url);
        });

        ownedUrls = nextUrls;

        setAttachments(next);
      } catch {
        if (
          !active ||
          requestGeneration !== generation
        ) {
          return;
        }

        setAttachments(
          ids.map((id) => ({
            id,
            name: "Attached file",
            kind: "unknown",
          })),
        );
      }
    }

    function handlePreviewSaved(event: Event) {
      const id = (
        event as CustomEvent<{
          id: string;
        }>
      ).detail?.id;

      if (ids.includes(id)) {
        void refresh();
      }
    }

    void refresh();

    window.addEventListener(
      CHAT_ATTACHMENT_PREVIEW_EVENT,
      handlePreviewSaved,
    );

    return () => {
      active = false;
      generation += 1;

      window.removeEventListener(
        CHAT_ATTACHMENT_PREVIEW_EVENT,
        handlePreviewSaved,
      );

      ownedUrls.forEach((url) => {
        URL.revokeObjectURL(url);
      });
    };
  }, [idsKey]);

  /* ==================================================== */
  /* CLEANUP                                              */
  /* ==================================================== */

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(
          copyTimerRef.current,
        );
      }
    };
  }, []);

  /* ==================================================== */
  /* COPY MESSAGE                                         */
  /* ==================================================== */

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(
        content,
      );

      setCopied(true);

      if (copyTimerRef.current !== null) {
        window.clearTimeout(
          copyTimerRef.current,
        );
      }

      copyTimerRef.current =
        window.setTimeout(() => {
          setCopied(false);
          copyTimerRef.current = null;
        }, 1500);
    } catch {
      setCopied(false);
    }
  }

  /* ==================================================== */
  /* EDIT MESSAGE                                         */
  /* ==================================================== */

  function startEditing() {
    setDraft(content);
    setIsEditing(true);
  }

  function cancelEditing() {
    if (saving) return;

    setDraft(content);
    setIsEditing(false);
  }

  async function handleSave() {
    const nextContent = draft.trim();

    if (!nextContent || saving) {
      return;
    }

    if (nextContent === content.trim()) {
      setIsEditing(false);
      return;
    }

    setSaving(true);

    try {
      await onEdit(nextContent);
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  }

  /* ==================================================== */
  /* RENDER                                               */
  /* ==================================================== */

  return (
    <>
      <div className="flex justify-end">
        <div className="flex max-w-[min(90%,760px)] flex-row-reverse items-start gap-3">
          <UserAvatar className="mt-0.5" />

          <div className="flex min-w-0 flex-1 flex-col items-end gap-2">
            {/* ======================================== */}
            {/* ATTACHED IMAGES AND DOCUMENTS            */}
            {/* ======================================== */}

            {attachments.length > 0 && (
              <div className="flex max-w-full flex-wrap justify-end gap-2">
                {attachments.map((attachment) =>
                  attachment.kind === "image" &&
                  attachment.url ? (
                    <button
                      key={attachment.id}
                      type="button"
                      onClick={() =>
                        setSelectedImage(
                          attachment,
                        )
                      }
                      aria-label={`View ${attachment.name}`}
                      title={attachment.name}
                      className={cn(
                        "relative overflow-hidden rounded-[15px] border outline-none transition-colors",
                        "focus-visible:ring-2 focus-visible:ring-white/30",
                        isDark
                          ? "border-white/[0.10] bg-[#1e1e1e]"
                          : "border-black/[0.10] bg-zinc-100",
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={attachment.url}
                        alt={attachment.name}
                        className="block max-h-[250px] max-w-[280px] object-contain"
                      />
                    </button>
                  ) : (
                    <div
                      key={attachment.id}
                      title={attachment.name}
                      className={cn(
                        "flex max-w-[260px] items-center gap-2.5 rounded-xl border px-3 py-2.5",
                        isDark
                          ? "border-white/[0.09] bg-[#202020] text-zinc-200"
                          : "border-black/[0.09] bg-zinc-100 text-zinc-800",
                      )}
                    >
                      {attachment.kind ===
                      "image" ? (
                        <ImageIcon
                          size={18}
                          className="shrink-0"
                        />
                      ) : (
                        <FileText
                          size={18}
                          className="shrink-0"
                        />
                      )}

                      <span className="truncate text-[12px]">
                        {attachment.name}
                      </span>
                    </div>
                  ),
                )}
              </div>
            )}

            {/* ======================================== */}
            {/* EDIT MESSAGE                             */}
            {/* ======================================== */}

            {isEditing ? (
              <div
                className={cn(
                  "w-full min-w-[min(280px,75vw)] rounded-[18px] border p-3",
                  isDark
                    ? "border-white/[0.08] bg-[#111111]"
                    : "border-black/[0.08] bg-white",
                )}
              >
                <textarea
                  autoFocus
                  value={draft}
                  onChange={(event) =>
                    setDraft(
                      event.target.value,
                    )
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Escape"
                    ) {
                      cancelEditing();
                    }

                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();

                      void handleSave();
                    }
                  }}
                  rows={Math.max(
                    2,
                    Math.min(
                      8,
                      draft.split("\n").length,
                    ),
                  )}
                  className={cn(
                    "min-h-[76px] w-full resize-none rounded-xl border px-3 py-2.5 text-[14px] leading-6 outline-none",
                    isDark
                      ? "border-white/[0.09] bg-[#0b0b0b] text-zinc-100"
                      : "border-black/[0.10] bg-white text-zinc-900",
                  )}
                />

                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={cancelEditing}
                    className={cn(
                      "inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[12px]",
                      isDark
                        ? "text-zinc-400 hover:bg-white/[0.06]"
                        : "text-zinc-600 hover:bg-black/[0.05]",
                    )}
                  >
                    <X size={14} />
                    Cancel
                  </button>

                  <button
                    type="button"
                    disabled={
                      saving ||
                      !draft.trim()
                    }
                    onClick={() =>
                      void handleSave()
                    }
                    className={cn(
                      "inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[12px] font-medium disabled:opacity-40",
                      isDark
                        ? "bg-white text-black"
                        : "bg-black text-white",
                    )}
                  >
                    <Check size={14} />

                    {saving
                      ? "Saving..."
                      : "Save & Regenerate"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* ==================================== */}
                {/* MESSAGE TEXT                         */}
                {/* ==================================== */}

                {content.length > 0 && (
                  <div
                    className={cn(
                      "max-w-full whitespace-pre-wrap break-words rounded-[18px] px-4 py-3 text-[14px] leading-6",
                      isDark
                        ? "bg-white/[0.08] text-zinc-100"
                        : "bg-zinc-100 text-zinc-900",
                    )}
                  >
                    {content}
                  </div>
                )}

                {/* ==================================== */}
                {/* ALWAYS-VISIBLE COPY / EDIT ACTIONS    */}
                {/* ==================================== */}

                <div
                  className="relative z-10 flex h-8 shrink-0 items-center justify-end gap-1"
                  aria-label="Message actions"
                >
                  <UserAction
                    theme={theme}
                    title={
                      copied ? "Copied" : "Copy"
                    }
                    onClick={() =>
                      void copyMessage()
                    }
                  >
                    {copied ? (
                      <Check size={14} />
                    ) : (
                      <Copy size={14} />
                    )}
                  </UserAction>

                  <UserAction
                    theme={theme}
                    title="Edit message"
                    onClick={startEditing}
                  >
                    <Pencil size={14} />
                  </UserAction>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ============================================== */}
      {/* FULL IMAGE PREVIEW                             */}
      {/* ============================================== */}

      <Dialog.Root
        open={selectedImage !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedImage(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[1600] bg-black/85 backdrop-blur-sm" />

          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-4 z-[1601] flex flex-col items-center justify-center outline-none"
          >
            <Dialog.Title className="sr-only">
              {selectedImage?.name ??
                "Attached image"}
            </Dialog.Title>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close image preview"
                className="absolute right-1 top-1 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-[#292929] text-white hover:bg-[#3a3a3a]"
              >
                <X size={20} />
              </button>
            </Dialog.Close>

            {selectedImage?.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={selectedImage.url}
                alt={selectedImage.name}
                className="max-h-[85vh] max-w-full rounded-xl object-contain shadow-2xl"
              />
            )}

            <p className="mt-3 max-w-[80vw] truncate text-center text-xs text-zinc-300">
              {selectedImage?.name}
            </p>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/* ====================================================== */
/* ACTION BUTTON                                         */
/* ====================================================== */

function UserAction({
  theme,
  title,
  onClick,
  children,
}: {
  theme: Theme;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
        isDark
          ? "text-zinc-400 hover:bg-white/[0.10] hover:text-white"
          : "text-zinc-500 hover:bg-black/[0.07] hover:text-zinc-900",
      )}
    >
      {children}
    </button>
  );
}
