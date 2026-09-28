"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import {
  Check,
  ChevronDown,
  Download,
  FilePenLine,
  FileText,
  Folder,
  FolderPlus,
  Grid2X2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

import {
  createLibraryFolder,
  deleteLibraryFile,
  deleteLibraryFolder,
  downloadLibraryFile,
  formatLibraryFileSize,
  getLibraryFiles,
  getLibraryFolders,
  renameLibraryFile,
  renameLibraryFolder,
  saveLibraryFile,
  updateLibraryFile,
  type LibraryFile,
  type LibraryFolder,
} from "@/lib/library";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type LibraryTab =
  | "all"
  | "images"
  | "documents"
  | "favorites"
  | "folders";

type SortMode =
  | "newest"
  | "oldest"
  | "name-asc"
  | "name-desc";

interface LibraryWorkspaceProps {
  theme: Theme;
}

const sortOptions: Array<{
  value: SortMode;
  label: string;
}> = [
  {
    value: "newest",
    label: "Newest",
  },
  {
    value: "oldest",
    label: "Oldest",
  },
  {
    value: "name-asc",
    label: "Name A–Z",
  },
  {
    value: "name-desc",
    label: "Name Z–A",
  },
];

export default function LibraryWorkspace({
  theme,
}: LibraryWorkspaceProps) {
  const fileInputRef =
    useRef<HTMLInputElement | null>(
      null,
    );

  const [
    files,
    setFiles,
  ] = useState<
    LibraryFile[]
  >([]);

  const [
    folders,
    setFolders,
  ] = useState<
    LibraryFolder[]
  >([]);

  const [
    loading,
    setLoading,
  ] = useState(
    true,
  );

  const [
    search,
    setSearch,
  ] = useState(
    "",
  );

  const [
    activeTab,
    setActiveTab,
  ] = useState<LibraryTab>(
    "all",
  );

  const [
    sortMode,
    setSortMode,
  ] = useState<SortMode>(
    "newest",
  );

  const [
    folderDialogOpen,
    setFolderDialogOpen,
  ] = useState(
    false,
  );

  const [
    folderName,
    setFolderName,
  ] = useState(
    "",
  );

  const [
    selectedFolderId,
    setSelectedFolderId,
  ] = useState<
    string | null
  >(
    null,
  );

  const [
    moveFile,
    setMoveFile,
  ] = useState<
    LibraryFile | null
  >(
    null,
  );

  const [
    previewFile,
    setPreviewFile,
  ] = useState<
    LibraryFile | null
  >(
    null,
  );

  const [
    previewUrls,
    setPreviewUrls,
  ] = useState<
    Record<string, string>
  >(
    {},
  );

  const [
    busy,
    setBusy,
  ] = useState(
    false,
  );

  const isDark =
    theme ===
    "dark";

  async function refreshLibrary() {
    const [
      nextFiles,
      nextFolders,
    ] =
      await Promise.all([
        getLibraryFiles(),
        getLibraryFolders(),
      ]);

    setFiles(
      nextFiles,
    );

    setFolders(
      nextFolders,
    );
  }

  useEffect(() => {
    void (async () => {
      try {
        await refreshLibrary();
      } finally {
        setLoading(
          false,
        );
      }
    })();
  }, []);

  useEffect(() => {
  const urls: Record<
    string,
    string
  > = {};

  for (const file of files) {
    if (
      file.kind !==
      "image"
    ) {
      continue;
    }

    urls[file.id] =
      URL.createObjectURL(
        file.blob,
      );
  }

  const frameId =
    window.requestAnimationFrame(
      () => {
        setPreviewUrls(
          urls,
        );
      },
    );

  return () => {
    window.cancelAnimationFrame(
      frameId,
    );

    Object.values(
      urls,
    ).forEach(
      (
        url,
      ) => {
        URL.revokeObjectURL(
          url,
        );
      },
    );
  };
}, [files]);

  const currentFolder =
    useMemo(
      () =>
        selectedFolderId
          ? folders.find(
              (
                folder,
              ) =>
                folder.id ===
                selectedFolderId,
            ) ??
            null
          : null,

      [
        folders,
        selectedFolderId,
      ],
    );

  const filteredFolders =
    useMemo(
      () => {
        const query =
          search
            .trim()
            .toLowerCase();

        if (
          !query
        ) {
          return folders;
        }

        return folders.filter(
          (
            folder,
          ) =>
            folder.name
              .toLowerCase()
              .includes(
                query,
              ),
        );
      },

      [
        folders,
        search,
      ],
    );

  const filteredFiles =
    useMemo(
      () => {
        const query =
          search
            .trim()
            .toLowerCase();

        const result =
          files.filter(
            (
              file,
            ) => {
              if (
                selectedFolderId &&
                file.folderId !==
                  selectedFolderId
              ) {
                return false;
              }

              if (
                !selectedFolderId &&
                activeTab ===
                  "folders"
              ) {
                return false;
              }

              if (
                activeTab ===
                  "images" &&
                file.kind !==
                  "image"
              ) {
                return false;
              }

              if (
                activeTab ===
                  "documents" &&
                file.kind !==
                  "document"
              ) {
                return false;
              }

              if (
                activeTab ===
                  "favorites" &&
                !file.favorite
              ) {
                return false;
              }

              if (
                query &&
                !file.name
                  .toLowerCase()
                  .includes(
                    query,
                  )
              ) {
                return false;
              }

              return true;
            },
          );

        return [
          ...result,
        ].sort(
          (
            left,
            right,
          ) => {
            switch (
              sortMode
            ) {
              case "oldest":
                return (
                  left.updatedAt -
                  right.updatedAt
                );

              case "name-asc":
                return left.name.localeCompare(
                  right.name,
                );

              case "name-desc":
                return right.name.localeCompare(
                  left.name,
                );

              default:
                return (
                  right.updatedAt -
                  left.updatedAt
                );
            }
          },
        );
      },

      [
        files,
        activeTab,
        search,
        sortMode,
        selectedFolderId,
      ],
    );

  const activeSortLabel =
    sortOptions.find(
      (
        option,
      ) =>
        option.value ===
        sortMode,
    )?.label ??
    "Newest";

  async function handleFilesSelected(
    selectedFiles:
      FileList | null,
  ) {
    if (
      !selectedFiles ||
      selectedFiles.length ===
        0
    ) {
      return;
    }

    setBusy(
      true,
    );

    try {
      for (
        const file of
        Array.from(
          selectedFiles,
        )
      ) {
        await saveLibraryFile(
          file,
          selectedFolderId,
        );
      }

      await refreshLibrary();
    } finally {
      setBusy(
        false,
      );

      if (
        fileInputRef.current
      ) {
        fileInputRef.current.value =
          "";
      }
    }
  }

  async function createFolder() {
    const trimmed =
      folderName.trim();

    if (
      !trimmed
    ) {
      return;
    }

    setBusy(
      true,
    );

    try {
      await createLibraryFolder(
        trimmed,
      );

      setFolderName(
        "",
      );

      setFolderDialogOpen(
        false,
      );

      await refreshLibrary();
    } finally {
      setBusy(
        false,
      );
    }
  }

  async function toggleFavorite(
    file:
      LibraryFile,
  ) {
    await updateLibraryFile({
      ...file,

      favorite:
        !file.favorite,
    });

    await refreshLibrary();
  }

  async function renameFile(
    file:
      LibraryFile,
  ) {
    const name =
      window.prompt(
        "Rename file",
        file.name,
      );

    if (
      !name?.trim()
    ) {
      return;
    }

    await renameLibraryFile(
      file,
      name,
    );

    await refreshLibrary();
  }

  async function moveFileToFolder(
    folderId:
      string | null,
  ) {
    if (
      !moveFile
    ) {
      return;
    }

    await updateLibraryFile({
      ...moveFile,
      folderId,
    });

    setMoveFile(
      null,
    );

    await refreshLibrary();
  }

  async function removeFile(
    file:
      LibraryFile,
  ) {
    const confirmed =
      window.confirm(
        `Delete "${file.name}" from Library?`,
      );

    if (
      !confirmed
    ) {
      return;
    }

    await deleteLibraryFile(
      file.id,
    );

    if (
      previewFile?.id ===
      file.id
    ) {
      setPreviewFile(
        null,
      );
    }

    await refreshLibrary();
  }

  async function renameFolder(
    folder:
      LibraryFolder,
  ) {
    const name =
      window.prompt(
        "Rename folder",
        folder.name,
      );

    if (
      !name?.trim()
    ) {
      return;
    }

    await renameLibraryFolder(
      folder,
      name,
    );

    await refreshLibrary();
  }

  async function removeFolder(
    folder:
      LibraryFolder,
  ) {
    const confirmed =
      window.confirm(
        `Delete folder "${folder.name}"?\n\nFiles inside it will be moved back to Library.`,
      );

    if (
      !confirmed
    ) {
      return;
    }

    await deleteLibraryFolder(
      folder.id,
    );

    if (
      selectedFolderId ===
      folder.id
    ) {
      setSelectedFolderId(
        null,
      );
    }

    await refreshLibrary();
  }

  const tabs:
    Array<{
      id:
        LibraryTab;

      label:
        string;
    }> = [
      {
        id:
          "all",

        label:
          "All",
      },

      {
        id:
          "images",

        label:
          "Images",
      },

      {
        id:
          "documents",

        label:
          "Documents",
      },

      {
        id:
          "favorites",

        label:
          "Favorites",
      },

      {
        id:
          "folders",

        label:
          "Folders",
      },
    ];

  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full flex-col overflow-hidden",

        isDark
          ? "bg-black text-white"
          : "bg-[#fafafa] text-zinc-950",
      )}
    >
      <input
        ref={
          fileInputRef
        }
        type="file"
        multiple
        className="hidden"
        onChange={(
          event,
        ) =>
          void handleFilesSelected(
            event.target
              .files,
          )
        }
      />

      {/* HEADER */}

      <div className="shrink-0 px-5 pb-0 pt-6 md:px-8 lg:px-10">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-[25px] font-semibold tracking-[-0.035em]">
              {currentFolder
                ? currentFolder.name
                : "Library"}
            </h1>

            {currentFolder ? (
              <button
                type="button"
                onClick={() =>
                  setSelectedFolderId(
                    null,
                  )
                }
                className="mt-1 text-[12px] text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
              >
                ← Back to Library
              </button>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* SEARCH */}

            <div
              className={cn(
                "flex h-10 min-w-[180px] flex-1 items-center gap-2 rounded-full border px-3 transition-colors sm:w-[230px] sm:flex-none",

                isDark
                  ? "border-white/[0.13] bg-black focus-within:border-white/[0.28]"
                  : "border-black/[0.13] bg-white focus-within:border-black/[0.28]",
              )}
            >
              <Search
                size={
                  16
                }
                className="shrink-0 text-zinc-500"
              />

              <input
                value={
                  search
                }
                onChange={(
                  event,
                ) =>
                  setSearch(
                    event.target
                      .value,
                  )
                }
                placeholder="Search library"
                autoComplete="off"
                className="min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-[13px] text-[color:var(--foreground)] outline-none shadow-none placeholder:text-[color:var(--muted-foreground)] focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:shadow-none"
                style={{
                  boxShadow:
                    "none",
                }}
              />

              {search ? (
                <button
                  type="button"
                  onClick={() =>
                    setSearch(
                      "",
                    )
                  }
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]"
                  aria-label="Clear search"
                >
                  <X
                    size={
                      13
                    }
                  />
                </button>
              ) : null}
            </div>

            {/* SORT */}

            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                asChild
              >
                <button
                  type="button"
                  className={cn(
                    "flex h-10 min-w-[105px] items-center justify-between gap-3 rounded-full border px-4 text-[12px] outline-none transition-colors",

                    isDark
                      ? "border-white/[0.13] bg-black text-zinc-200 hover:bg-[#181818]"
                      : "border-black/[0.13] bg-white text-zinc-700 hover:bg-zinc-100",
                  )}
                >
                  <span>
                    {
                      activeSortLabel
                    }
                  </span>

                  <ChevronDown
                    size={
                      14
                    }
                    className="text-zinc-500"
                  />
                </button>
              </DropdownMenu.Trigger>

              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  sideOffset={
                    7
                  }
                  align="end"
                  collisionPadding={
                    12
                  }
                  className={cn(
                    "z-[1200] w-[165px] rounded-[14px] border p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.65)]",

                    isDark
                      ? "border-white/[0.09] bg-[#202020] text-white"
                      : "border-black/[0.10] bg-white text-black",
                  )}
                >
                  {sortOptions.map(
                    (
                      option,
                    ) => {
                      const selected =
                        option.value ===
                        sortMode;

                      return (
                        <DropdownMenu.Item
                          key={
                            option.value
                          }
                          onSelect={() =>
                            setSortMode(
                              option.value,
                            )
                          }
                          className={cn(
                            "flex cursor-pointer items-center justify-between rounded-[9px] px-3 py-2.5 text-[12px] outline-none",

                            isDark
                              ? "text-zinc-300 hover:bg-[#303030] focus:bg-[#303030]"
                              : "text-zinc-700 hover:bg-zinc-100 focus:bg-zinc-100",
                          )}
                        >
                          {
                            option.label
                          }

                          {selected ? (
                            <Check
                              size={
                                14
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

            {/* NEW */}

            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                asChild
              >
                <button
                  type="button"
                  disabled={
                    busy
                  }
                  className={cn(
                    "flex h-10 items-center gap-2 rounded-full px-4 text-[13px] font-medium",

                    isDark
                      ? "bg-white text-black hover:bg-zinc-200"
                      : "bg-black text-white hover:bg-zinc-800",
                  )}
                >
                  <Plus
                    size={
                      15
                    }
                  />

                  New
                </button>
              </DropdownMenu.Trigger>

              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  sideOffset={
                    7
                  }
                  align="end"
                  className={cn(
                    "z-[1200] w-[190px] rounded-[14px] border p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.65)]",

                    isDark
                      ? "border-white/[0.09] bg-[#202020]"
                      : "border-black/[0.10] bg-white",
                  )}
                >
                  <DropdownMenu.Item
                    onSelect={() =>
                      fileInputRef.current?.click()
                    }
                    className="flex cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2.5 text-[12px] text-[color:var(--foreground)] outline-none hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)]"
                  >
                    <Upload
                      size={
                        15
                      }
                    />

                    Upload files
                  </DropdownMenu.Item>

                  <DropdownMenu.Item
                    onSelect={() =>
                      setFolderDialogOpen(
                        true,
                      )
                    }
                    className="flex cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2.5 text-[12px] text-[color:var(--foreground)] outline-none hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)]"
                  >
                    <FolderPlus
                      size={
                        15
                      }
                    />

                    New folder
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>

        {/* TABS */}

        {!currentFolder ? (
          <div className="mx-auto mt-6 flex w-full max-w-[1500px] items-center gap-1 overflow-x-auto border-b border-[color:var(--border)]">
            {tabs.map(
              (
                tab,
              ) => {
                const active =
                  activeTab ===
                  tab.id;

                return (
                  <button
                    key={
                      tab.id
                    }
                    type="button"
                    onClick={() =>
                      setActiveTab(
                        tab.id,
                      )
                    }
                    className={cn(
                      "relative shrink-0 px-4 pb-3 pt-2 text-[13px] transition-colors",

                      active
                        ? "text-[color:var(--foreground)]"
                        : "text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]",
                    )}
                  >
                    {
                      tab.label
                    }

                    {active ? (
                      <span className="absolute bottom-0 left-3 right-3 h-[2px] rounded-full bg-[color:var(--foreground)]" />
                    ) : null}
                  </button>
                );
              },
            )}
          </div>
        ) : null}
      </div>

      {/* CONTENT */}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-12 pt-7 md:px-8 lg:px-10">
        <div className="mx-auto w-full max-w-[1500px]">
          {loading ? (
            <LibraryEmpty
              title="Loading Library..."
              body="Getting your files ready."
            />
          ) : (
            <>
              {!currentFolder &&
              (
                activeTab ===
                  "all" ||
                activeTab ===
                  "folders"
              ) &&
              filteredFolders.length >
                0 ? (
                <section className="mb-9">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-[13px] font-medium text-[color:var(--muted-foreground)]">
                      Folders
                    </h2>

                    <span className="text-[11px] text-[color:var(--muted-foreground)]">
                      {
                        filteredFolders.length
                      }{" "}
                      folders
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {filteredFolders.map(
                      (
                        folder,
                      ) => (
                        <FolderCard
                          key={
                            folder.id
                          }
                          folder={
                            folder
                          }
                          theme={
                            theme
                          }
                          onOpen={() =>
                            setSelectedFolderId(
                              folder.id,
                            )
                          }
                          onRename={() =>
                            void renameFolder(
                              folder,
                            )
                          }
                          onDelete={() =>
                            void removeFolder(
                              folder,
                            )
                          }
                        />
                      ),
                    )}
                  </div>
                </section>
              ) : null}

              {activeTab !==
                "folders" ||
              currentFolder ? (
                filteredFiles.length >
                0 ? (
                  <section>
                    <div className="mb-4 flex items-center justify-between">
                      <h2 className="text-[13px] font-medium text-[color:var(--muted-foreground)]">
                        {currentFolder
                          ? "Files"
                          : activeTab ===
                              "images"
                            ? "Images"
                            : activeTab ===
                                "documents"
                              ? "Documents"
                              : activeTab ===
                                  "favorites"
                                ? "Favorites"
                                : "Files"}
                      </h2>

                      <span className="text-[11px] text-[color:var(--muted-foreground)]">
                        {
                          filteredFiles.length
                        }{" "}
                        items
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                      {filteredFiles.map(
                        (
                          file,
                        ) => (
                          <LibraryFileCard
                            key={
                              file.id
                            }
                            file={
                              file
                            }
                            previewUrl={
                              previewUrls[
                                file.id
                              ]
                            }
                            theme={
                              theme
                            }
                            onPreview={() =>
                              setPreviewFile(
                                file,
                              )
                            }
                            onRename={() =>
                              void renameFile(
                                file,
                              )
                            }
                            onFavorite={() =>
                              void toggleFavorite(
                                file,
                              )
                            }
                            onDownload={() =>
                              downloadLibraryFile(
                                file,
                              )
                            }
                            onMove={() =>
                              setMoveFile(
                                file,
                              )
                            }
                            onDelete={() =>
                              void removeFile(
                                file,
                              )
                            }
                          />
                        ),
                      )}
                    </div>
                  </section>
                ) : (
                  <LibraryEmpty
                    title={
                      search
                        ? "Nothing found"
                        : currentFolder
                          ? "This folder is empty"
                          : activeTab ===
                              "favorites"
                            ? "No favorites yet"
                            : activeTab ===
                                "images"
                              ? "No images yet"
                              : activeTab ===
                                  "documents"
                                ? "No documents yet"
                                : "Your Library is empty"
                    }
                    body={
                      search
                        ? "Try a different search."
                        : "Upload files to keep them available in Clawbit."
                    }
                    action={
                      !search
                        ? () =>
                            fileInputRef.current?.click()
                        : undefined
                    }
                  />
                )
              ) : filteredFolders.length ===
                0 ? (
                <LibraryEmpty
                  title="No folders yet"
                  body="Create folders to organize your Library."
                  action={() =>
                    setFolderDialogOpen(
                      true,
                    )
                  }
                  actionLabel="Create folder"
                />
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* CREATE FOLDER */}

      {folderDialogOpen ? (
        <ModalOverlay
          onClose={() =>
            setFolderDialogOpen(
              false,
            )
          }
        >
          <div className="ui-dialog-surface w-[min(92vw,430px)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold">
                New folder
              </h2>

              <button
                type="button"
                onClick={() =>
                  setFolderDialogOpen(
                    false,
                  )
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]"
              >
                <X
                  size={
                    16
                  }
                />
              </button>
            </div>

            <input
              autoFocus
              value={
                folderName
              }
              onChange={(
                event,
              ) =>
                setFolderName(
                  event.target
                    .value,
                )
              }
              onKeyDown={(
                event,
              ) => {
                if (
                  event.key ===
                  "Enter"
                ) {
                  void createFolder();
                }
              }}
              placeholder="Folder name"
              className="ui-input mt-5 h-11 w-full text-[13px]"
            />

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() =>
                  setFolderDialogOpen(
                    false,
                  )
                }
                className="h-10 rounded-[10px] px-4 text-[13px] text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={
                  !folderName.trim() ||
                  busy
                }
                onClick={() =>
                  void createFolder()
                }
                className="h-10 rounded-[10px] bg-[color:var(--accent)] px-4 text-[13px] font-medium text-[color:var(--accent-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </div>
        </ModalOverlay>
      ) : null}

      {/* MOVE FILE */}

      {moveFile ? (
        <ModalOverlay
          onClose={() =>
            setMoveFile(
              null,
            )
          }
        >
          <div className="ui-dialog-surface w-[min(92vw,450px)] p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[16px] font-semibold">
                  Move file
                </h2>

                <p className="mt-1 max-w-[320px] truncate text-[12px] text-zinc-500">
                  {
                    moveFile.name
                  }
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  setMoveFile(
                    null,
                  )
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]"
              >
                <X
                  size={
                    16
                  }
                />
              </button>
            </div>

            <div className="mt-4 max-h-[320px] space-y-1 overflow-y-auto">
              <MoveDestination
                name="Library"
                selected={
                  moveFile.folderId ===
                  null
                }
                onClick={() =>
                  void moveFileToFolder(
                    null,
                  )
                }
              />

              {folders.map(
                (
                  folder,
                ) => (
                  <MoveDestination
                    key={
                      folder.id
                    }
                    name={
                      folder.name
                    }
                    selected={
                      moveFile.folderId ===
                      folder.id
                    }
                    onClick={() =>
                      void moveFileToFolder(
                        folder.id,
                      )
                    }
                  />
                ),
              )}
            </div>
          </div>
        </ModalOverlay>
      ) : null}

      {/* PREVIEW */}

      {previewFile ? (
        <ModalOverlay
          onClose={() =>
            setPreviewFile(
              null,
            )
          }
        >
          <div className="ui-dialog-surface flex max-h-[90vh] w-[min(94vw,1000px)] flex-col overflow-hidden rounded-[20px]">
            <div className="flex shrink-0 items-center justify-between border-b border-[color:var(--border)] px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium">
                  {
                    previewFile.name
                  }
                </p>

                <p className="mt-1 text-[11px] text-zinc-500">
                  {formatLibraryFileSize(
                    previewFile.size,
                  )}
                </p>
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    downloadLibraryFile(
                      previewFile,
                    )
                  }
                  className="flex h-9 w-9 items-center justify-center rounded-[9px] text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]"
                  title="Download"
                >
                  <Download
                    size={
                      16
                    }
                  />
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setPreviewFile(
                      null,
                    )
                  }
                  className="flex h-9 w-9 items-center justify-center rounded-[9px] text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)]"
                >
                  <X
                    size={
                      17
                    }
                  />
                </button>
              </div>
            </div>

            <div className="flex min-h-[420px] flex-1 items-center justify-center overflow-auto bg-black p-6 text-zinc-200">
              {previewFile.kind ===
                "image" &&
              previewUrls[
                previewFile.id
              ] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={
                    previewUrls[
                      previewFile.id
                    ]
                  }
                  alt={
                    previewFile.name
                  }
                  className="max-h-[70vh] max-w-full rounded-xl object-contain"
                />
              ) : (
                <div className="text-center">
                  <FileText
                    size={
                      44
                    }
                    className="mx-auto text-zinc-600"
                  />

                  <p className="mt-4 text-[14px] font-medium">
                    {
                      previewFile.name
                    }
                  </p>

                  <p className="mt-2 text-[12px] text-zinc-500">
                    This document
                    is stored in
                    Library. Inline
                    preview for this
                    file type is not
                    available yet.
                  </p>
                </div>
              )}
            </div>
          </div>
        </ModalOverlay>
      ) : null}
    </div>
  );
}

/* ====================================================== */
/* FILE CARD                                              */
/* ====================================================== */

function LibraryFileCard({
  file,
  previewUrl,
  theme,
  onPreview,
  onRename,
  onFavorite,
  onDownload,
  onMove,
  onDelete,
}: {
  file:
    LibraryFile;

  previewUrl?:
    string;

  theme:
    Theme;

  onPreview:
    () => void;

  onRename:
    () => void;

  onFavorite:
    () => void;

  onDownload:
    () => void;

  onMove:
    () => void;

  onDelete:
    () => void;
}) {
  const isDark =
    theme ===
    "dark";

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-[16px] border transition-colors",

        isDark
          ? "border-white/[0.075] bg-[#0d0d0d] hover:border-white/[0.14]"
          : "border-black/[0.09] bg-white",
      )}
    >
      <button
        type="button"
        onClick={
          onPreview
        }
        className="block w-full text-left"
      >
        <div
          className={cn(
            "flex aspect-[4/3] items-center justify-center overflow-hidden",

            isDark
              ? "bg-[#111111]"
              : "bg-[#f3f3f3]",
          )}
        >
          {file.kind ===
            "image" &&
          previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={
                previewUrl
              }
              alt={
                file.name
              }
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            />
          ) : (
            <FileText
              size={
                34
              }
              className="text-zinc-600"
            />
          )}
        </div>

        <div className="p-3.5 pr-10">
          <p className="truncate text-[13px] font-medium">
            {
              file.name
            }
          </p>

          <p className="mt-1.5 text-[11px] text-zinc-600">
            {formatLibraryFileSize(
              file.size,
            )}
          </p>
        </div>
      </button>

      {file.favorite ? (
        <span className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-white backdrop-blur">
          <Star
            size={
              13
            }
            fill="currentColor"
          />
        </span>
      ) : null}

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          asChild
        >
          <button
            type="button"
            className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-[9px] bg-black/60 text-zinc-300 opacity-0 backdrop-blur transition-opacity hover:bg-black/80 focus:opacity-100 group-hover:opacity-100"
            aria-label="File options"
          >
            <MoreHorizontal
              size={
                16
              }
            />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            sideOffset={
              6
            }
            align="end"
            className="ui-menu-surface z-[1200] w-[175px] p-1.5 text-[color:var(--foreground)] outline-none"
          >
            <DropdownAction
              icon={
                Pencil
              }
              label="Rename"
              onSelect={
                onRename
              }
            />

            <DropdownAction
              icon={
                Star
              }
              label={
                file.favorite
                  ? "Unfavorite"
                  : "Favorite"
              }
              onSelect={
                onFavorite
              }
            />

            <DropdownAction
              icon={
                Folder
              }
              label="Move"
              onSelect={
                onMove
              }
            />

            <DropdownAction
              icon={
                Download
              }
              label="Download"
              onSelect={
                onDownload
              }
            />

            <div className="my-1 border-t border-[color:var(--border)]" />

            <DropdownAction
              icon={
                Trash2
              }
              label="Delete"
              destructive
              onSelect={
                onDelete
              }
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </article>
  );
}

/* ====================================================== */
/* FOLDER CARD                                            */
/* ====================================================== */

function FolderCard({
  folder,
  theme,
  onOpen,
  onRename,
  onDelete,
}: {
  folder:
    LibraryFolder;

  theme:
    Theme;

  onOpen:
    () => void;

  onRename:
    () => void;

  onDelete:
    () => void;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={
          onOpen
        }
        className={cn(
          "flex w-full items-center gap-3 rounded-[14px] border px-4 py-4 pr-12 text-left transition-colors",

          theme ===
          "dark"
            ? "border-white/[0.075] bg-[#0d0d0d] hover:bg-[#171717]"
            : "border-black/[0.09] bg-white hover:bg-zinc-50",
        )}
      >
        <Folder
          size={
            20
          }
          className="shrink-0 text-zinc-400"
        />

        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {
            folder.name
          }
        </span>
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          asChild
        >
          <button
            type="button"
            aria-label="Folder options"
            className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-[8px] text-[color:var(--muted-foreground)] opacity-0 hover:bg-[color:var(--accent-hover)] hover:text-[color:var(--foreground)] focus:opacity-100 group-hover:opacity-100"
          >
            <MoreHorizontal
              size={
                16
              }
            />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            sideOffset={
              6
            }
            align="end"
            className="ui-menu-surface z-[1200] w-[160px] p-1.5 text-[color:var(--foreground)] outline-none"
          >
            <DropdownAction
              icon={
                FilePenLine
              }
              label="Rename"
              onSelect={
                onRename
              }
            />

            <div className="my-1 border-t border-[color:var(--border)]" />

            <DropdownAction
              icon={
                Trash2
              }
              label="Delete"
              destructive
              onSelect={
                onDelete
              }
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

/* ====================================================== */
/* DROPDOWN ACTION                                        */
/* ====================================================== */

function DropdownAction({
  icon: Icon,
  label,
  destructive = false,
  onSelect,
}: {
  icon:
    ComponentType<{
      size?:
        number;
    }>;

  label:
    string;

  destructive?:
    boolean;

  onSelect:
    () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={
        onSelect
      }
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2.5 text-[12px] outline-none",

        destructive
          ? "text-red-600 hover:bg-red-50 focus:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/[0.08] dark:focus:bg-red-500/[0.08]"
          : "text-[color:var(--foreground)] hover:bg-[color:var(--accent-hover)] focus:bg-[color:var(--accent-hover)]",
      )}
    >
      <Icon
        size={
          15
        }
      />

      {label}
    </DropdownMenu.Item>
  );
}

/* ====================================================== */
/* EMPTY                                                  */
/* ====================================================== */

function LibraryEmpty({
  title,
  body,
  action,
  actionLabel = "Upload files",
}: {
  title:
    string;

  body:
    string;

  action?:
    () => void;

  actionLabel?:
    string;
}) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-[16px] border border-[color:var(--border)] bg-[color:var(--surface)]">
        <Grid2X2
          size={
            21
          }
          className="text-zinc-500"
        />
      </div>

      <h2 className="mt-5 text-[15px] font-medium">
        {
          title
        }
      </h2>

      <p className="mt-2 max-w-[360px] text-[12px] leading-5 text-zinc-500">
        {
          body
        }
      </p>

      {action ? (
        <button
          type="button"
          onClick={
            action
          }
          className="mt-5 rounded-[10px] bg-[color:var(--accent)] px-4 py-2.5 text-[12px] font-medium text-[color:var(--accent-foreground)] transition-opacity hover:opacity-90"
        >
          {
            actionLabel
          }
        </button>
      ) : null}
    </div>
  );
}

/* ====================================================== */
/* MOVE DESTINATION                                       */
/* ====================================================== */

function MoveDestination({
  name,
  selected,
  onClick,
}: {
  name:
    string;

  selected:
    boolean;

  onClick:
    () => void;
}) {
  return (
    <button
      type="button"
      onClick={
        onClick
      }
      className={cn(
        "flex w-full items-center gap-3 rounded-[10px] px-3 py-3 text-left text-[13px]",

        selected
          ? "bg-[color:var(--accent-hover)] text-[color:var(--foreground)]"
          : "text-[color:var(--foreground)] hover:bg-[color:var(--accent-hover)]",
      )}
    >
      <Folder
        size={
          16
        }
        className="text-zinc-500"
      />

      <span className="min-w-0 flex-1 truncate">
        {
          name
        }
      </span>

      {selected ? (
        <span className="text-[10px] text-zinc-500">
          Current
        </span>
      ) : null}
    </button>
  );
}

/* ====================================================== */
/* MODAL                                                  */
/* ====================================================== */

function ModalOverlay({
  children,
  onClose,
}: {
  children:
    ReactNode;

  onClose:
    () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(
        event,
      ) => {
        if (
          event.target ===
          event.currentTarget
        ) {
          onClose();
        }
      }}
    >
      {children}
    </div>
  );
}