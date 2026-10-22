"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { downloadSource, loadSource, sourceUrl, type SourceReference } from "@/lib/knowledge";

export default function SourceCitation({ source }: { source?: SourceReference }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (!source) return <span className="text-muted-foreground">[Unverified source]</span>;
  const label = `${source.file}${source.page ? `, page ${source.page}` : ""}`;
  const url = sourceUrl(source);
  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
        [{label}]
      </a>
    );
  }
  if (source.kind === "web") {
    return <span className="text-muted-foreground">[Unverified source]</span>;
  }

  async function showSource() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setOpen(true);
    setError("");
    setPreview("Loading source…");
    try {
      const result = await loadSource(source!, current.signal);
      if (!current.signal.aborted) {
        setPreview(result.preview || "No text preview is available. Download the original document below.");
      }
    } catch (failure) {
      if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : "Source unavailable.");
    }
  }

  return <>
    <button
      type="button"
      onClick={() => void showSource()}
      className="underline underline-offset-2"
      aria-label={`Open source ${label}`}
    >
      [{label}]
    </button>
    <Dialog.Root open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) controller.current?.abort();
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[80vh] w-[min(90vw,640px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border bg-background p-6 text-foreground shadow-xl">
          <Dialog.Title className="font-semibold">{label}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            Document preview. Page references locate the original source; this preview may show a different section.
          </Dialog.Description>
          {error ? (
            <p role="alert" className="my-4">{error}</p>
          ) : (
            <pre className="my-4 whitespace-pre-wrap font-sans text-sm">{preview}</pre>
          )}
          {!error && (
            <button
              type="button"
              className="mr-4 underline"
              onClick={() => void downloadSource(source).catch((failure) => setError(failure.message))}
            >
              Download original
            </button>
          )}
          <Dialog.Close className="underline">Close</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
