
"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  Check,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  getLibraryFiles,
  getLibraryFolders,
  type LibraryFile,
  type LibraryFolder,
  formatLibraryFileSize,
} from "@/lib/library";

interface LibraryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAttach: (files: File[]) => void;
}

export default function LibraryPicker({
  open,
  onOpenChange,
  onAttach,
}: LibraryPickerProps) {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;

    let active = true;

    async function refresh() {
      if (active) {
        setLoading(true);
      }

      try {
        const [savedFiles, savedFolders] = await Promise.all([
          getLibraryFiles(),
          getLibraryFolders(),
        ]);

        if (!active) return;

        setFiles(savedFiles);
        setFolders(savedFolders);
        setError("");
      } catch {
        if (active) {
          setError("Could not load Library files from this browser.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void refresh();

    window.addEventListener("clawbit-library-updated", refresh);

    return () => {
      active = false;
      window.removeEventListener("clawbit-library-updated", refresh);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const nextUrls: Record<string, string> = {};

    for (const file of files) {
      if (file.kind === "image") {
        nextUrls[file.id] = URL.createObjectURL(file.blob);
      }
    }

    const frame = requestAnimationFrame(() => {
      setUrls(nextUrls);
    });

    return () => {
      cancelAnimationFrame(frame);

      Object.values(nextUrls).forEach((url) => {
        URL.revokeObjectURL(url);
      });
    };
  }, [files, open]);

  const visibleFiles = useMemo(() => {
    const query = search.trim().toLowerCase();

    return files.filter(
      (file) =>
        (folderId === null || file.folderId === folderId) &&
        (!query || file.name.toLowerCase().includes(query)),
    );
  }, [files, folderId, search]);

  function toggleSelection(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((selected) => selected !== id)
        : [...current, id],
    );
  }

  function attachSelected() {
    const selected = selectedIds
      .map((id) => files.find((file) => file.id === id))
      .filter((file): file is LibraryFile => Boolean(file));

    if (!selected.length) return;

    const uploads = selected.map(
      (entry) =>
        new File([entry.blob], entry.name, {
          type: entry.mimeType,
          lastModified: entry.updatedAt,
        }),
    );

    onOpenChange(false);
    setSelectedIds([]);
    onAttach(uploads);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[1500] bg-black/65 backdrop-blur-[2px]" />

        <Dialog.Content className="fixed left-1/2 top-1/2 z-[1501] flex h-[min(78vh,690px)] w-[min(94vw,880px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[color:var(--border-strong)] bg-[color:var(--surface)] text-[color:var(--foreground)] shadow-2xl outline-none">
          <div className="flex shrink-0 items-start justify-between border-b border-[color:var(--border)] px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold">
                Add from Library
              </Dialog.Title>

              <Dialog.Description className="mt-1 text-xs text-[color:var(--muted-foreground)]">
                Select saved files to attach to this conversation.
              </Dialog.Description>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close Library"
                className="rounded-lg p-2 text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav
              aria-label="Library folders"
              className="flex shrink-0 gap-1 overflow-x-auto border-b border-[color:var(--border)] p-3 sm:w-[180px] sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r"
            >
              <button
                type="button"
                onClick={() => setFolderId(null)}
                className={`shrink-0 rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                  folderId === null
                    ? "bg-[color:var(--accent-hover)] font-medium"
                    : "text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)]"
                }`}
              >
                All files
              </button>

              {folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  onClick={() => setFolderId(folder.id)}
                  title={folder.name}
                  className={`shrink-0 truncate rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                    folderId === folder.id
                      ? "bg-[color:var(--accent-hover)] font-medium"
                      : "text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)]"
                  }`}
                >
                  {folder.name}
                </button>
              ))}
            </nav>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="relative m-4 mb-2">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--muted-foreground)]"
                />

                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="Search Library files"
                  placeholder="Search files"
                  className="h-10 w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--background)] pl-10 pr-3 text-[13px] text-[color:var(--foreground)] outline-none focus:border-[color:var(--border-strong)]"
                />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 pt-2">
                {loading ? (
                  <div
                    role="status"
                    className="flex items-center justify-center gap-2 py-20 text-sm text-[color:var(--muted-foreground)]"
                  >
                    <LoaderCircle
                      className="animate-spin"
                      size={17}
                    />
                    Loading Library...
                  </div>
                ) : error ? (
                  <p
                    role="alert"
                    className="py-12 text-center text-sm text-red-400"
                  >
                    {error}
                  </p>
                ) : visibleFiles.length === 0 ? (
                  <div className="py-16 text-center text-sm text-[color:var(--muted-foreground)]">
                    {search
                      ? "No matching files."
                      : "No saved files here. Upload a file in chat or Library first."}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                    {visibleFiles.map((file) => {
                      const selected = selectedIds.includes(file.id);

                      return (
                        <button
                          key={file.id}
                          type="button"
                          onClick={() => toggleSelection(file.id)}
                          aria-pressed={selected}
                          className={`group relative min-w-0 overflow-hidden rounded-xl border text-left transition-colors ${
                            selected
                              ? "border-[color:var(--foreground)]"
                              : "border-[color:var(--border)] hover:border-[color:var(--border-strong)]"
                          }`}
                        >
                          <div className="flex h-24 items-center justify-center bg-[color:var(--background)]">
                            {file.kind === "image" && urls[file.id] ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={urls[file.id]}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            ) : file.kind === "image" ? (
                              <ImageIcon
                                size={26}
                                className="text-[color:var(--muted-foreground)]"
                              />
                            ) : (
                              <FileText
                                size={26}
                                className="text-[color:var(--muted-foreground)]"
                              />
                            )}
                          </div>

                          <div className="px-2.5 py-2">
                            <p
                              className="truncate text-[12px] font-medium"
                              title={file.name}
                            >
                              {file.name}
                            </p>

                            <p className="mt-1 text-[10px] text-[color:var(--muted-foreground)]">
                              {formatLibraryFileSize(file.size)}
                            </p>
                          </div>

                          {selected && (
                            <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-[color:var(--foreground)] text-[color:var(--background)]">
                              <Check size={15} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[color:var(--border)] px-5 py-3">
            <p className="text-xs text-[color:var(--muted-foreground)]">
              {selectedIds.length} selected
            </p>

            <button
              type="button"
              disabled={!selectedIds.length || loading}
              onClick={attachSelected}
              className="h-9 rounded-lg bg-[color:var(--foreground)] px-4 text-xs font-semibold text-[color:var(--background)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Attach to chat
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
