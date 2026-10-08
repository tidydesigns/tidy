"use client";

import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { filesHeader, filesGrid } from "@/components/workspace/page-layout";
import { Dialog } from "@/components/ui/dialog";
import { Fragment, useEffect, useRef, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import {
  deleteArchivedDesignFile,
  createDesignFolder,
  deleteDesignFolder,
  duplicateDesignFile,
  duplicateDesignFolder,
  moveDesignFile,
  renameDesignFile,
  renameDesignFolder,
  setDesignFileArchived,
} from "./actions";
import { NewFileButton } from "./new-file-button";
import { FileThumbnail, FileThumbnailUpdates } from "./file-thumbnail";
import { fileVersion } from "@/lib/design/file-version";

type File = {
  id: string;
  name: string;
  folderId: string | null;
  updatedAt: string;
  createdAt: string;
  creatorName: string;
  creatorImage: string | null;
  frameCount: number;
  rectangleCount: number;
  nodeCount: number | null;
  documentRevision: number | null;
  thumbnailVersion: string | null;
};
type Folder = {
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
  creatorName: string;
  creatorImage: string | null;
};
type Menu =
  | { kind: "file"; file: File; x: number; y: number; mode: "actions" | "move" }
  | { kind: "folder"; folder: Folder; x: number; y: number; mode: "actions" };
type RenameTarget = { kind: "file"; file: File } | { kind: "folder"; folder: Folder };

const menuItem =
  "block w-full rounded px-3 py-2 text-left text-sm hover:bg-primary-grey/25 focus-visible:bg-primary-grey/25 focus-visible:outline-none disabled:opacity-50";
const folderCard =
  "flex h-24 items-center gap-4 rounded-xl border border-primary-grey/70 px-5 pr-12 transition-colors hover:border-primary-grey hover:bg-surface/40";
const listColumns =
  "grid grid-cols-[minmax(0,1fr)_32px] items-center gap-x-4 sm:grid-cols-[minmax(0,1fr)_110px_32px] lg:grid-cols-[minmax(0,1fr)_110px_110px_150px_32px] xl:grid-cols-[minmax(0,1fr)_110px_110px_150px_100px_32px]";

function relativeDate(value: string, asOf: string) {
  const elapsed = Math.max(0, new Date(asOf).getTime() - new Date(value).getTime());
  if (elapsed < 3600000) return "Just now";
  if (elapsed < 86400000) {
    const hours = Math.floor(elapsed / 3600000);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(elapsed / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} ${days < 14 ? "week" : "weeks"} ago`;
  if (days < 365) return `${Math.floor(days / 30)} ${days < 60 ? "month" : "months"} ago`;
  return `${Math.floor(days / 365)} ${days < 730 ? "year" : "years"} ago`;
}

function DateCell({
  value,
  asOf,
  className = "",
}: {
  value: string;
  asOf: string;
  className?: string;
}) {
  return (
    <time
      dateTime={value}
      title={new Date(value).toLocaleDateString("en-IE", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })}
      className={`truncate text-sm text-secondary-ink ${className}`}
    >
      {relativeDate(value, asOf)}
    </time>
  );
}

function CreatorCell({ name }: { name: string }) {
  return (
    <span className="hidden min-w-0 items-center gap-2 lg:flex">
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-black/10 text-xs font-semibold text-primary-black/70"
      >
        {name.trim().charAt(0).toUpperCase()}
      </span>
      <span className="truncate text-sm text-secondary-ink">{name}</span>
    </span>
  );
}

export function FilesBrowser({
  files,
  folders,
  currentFolder,
  archived,
  asOf,
  canEdit = true,
  thumbnailScope,
}: {
  files: File[];
  folders: Folder[];
  currentFolder: Folder | null;
  archived: boolean;
  asOf: string;
  canEdit?: boolean;
  thumbnailScope?: string;
}) {
  const router = useRouter();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [newestFirst, setNewestFirst] = useState(true);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [deletingFile, setDeletingFile] = useState<File | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamedFiles, setRenamedFiles] = useState<Record<string, string>>({});
  const [renamedFolders, setRenamedFolders] = useState<Record<string, string>>({});
  const [hiddenFileIds, setHiddenFileIds] = useState<string[]>([]);
  const [movedFromByFileId, setMovedFromByFileId] = useState<Record<string, string | null>>({});
  const [hiddenFolderIds, setHiddenFolderIds] = useState<string[]>([]);
  const [addedFolders, setAddedFolders] = useState<Folder[]>([]);
  const [addedFiles, setAddedFiles] = useState<File[]>([]);
  const [expandedFolderIds, setExpandedFolderIds] = useState<string[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const cancelFolderRef = useRef(false);
  const cancelRenameRef = useRef(false);

  function changeView(next: "grid" | "list") {
    setView(next);
  }

  const serverFolderIds = new Set(folders.map((folder) => folder.id));
  const serverFileIds = new Set(files.map((file) => file.id));
  const visibleFolders = [
    ...addedFolders.filter((folder) => !serverFolderIds.has(folder.id)),
    ...folders,
  ].filter((folder) => !hiddenFolderIds.includes(folder.id));
  const isVisibleFile = (file: File) =>
    !hiddenFileIds.includes(file.id) &&
    (!Object.hasOwn(movedFromByFileId, file.id) || movedFromByFileId[file.id] !== file.folderId);
  const allVisibleFiles = [
    ...addedFiles.filter((file) => !serverFileIds.has(file.id)),
    ...files,
  ].filter(isVisibleFile);
  const visibleFiles = allVisibleFiles.filter(
    (file) => archived || file.folderId === (currentFolder?.id ?? null),
  );
  const sortedFolders = [...visibleFolders].sort(
    (a, b) =>
      (newestFirst ? -1 : 1) * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()),
  );
  const sortedFiles = [...visibleFiles].sort(
    (a, b) =>
      (newestFirst ? -1 : 1) * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()),
  );

  function visibleFilesInFolder(folderId: string) {
    return allVisibleFiles
      .filter((file) => file.folderId === folderId)
      .sort(
        (a, b) =>
          (newestFirst ? -1 : 1) *
          (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()),
      );
  }

  function toggleFolder(folder: Folder) {
    setExpandedFolderIds((current) =>
      current.includes(folder.id)
        ? current.filter((id) => id !== folder.id)
        : [...current, folder.id],
    );
  }

  useEffect(() => {
    if (!menu) return;
    function dismiss(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenu(null);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  useEffect(() => {
    if ((deletingFolder || deletingFile) && !deleteDialogRef.current?.open)
      deleteDialogRef.current?.showModal();
  }, [deletingFolder, deletingFile]);

  function showMenu(
    target: { kind: "file"; file: File } | { kind: "folder"; folder: Folder },
    x: number,
    y: number,
  ) {
    setMenu({
      ...target,
      x: Math.max(8, Math.min(x, window.innerWidth - 232)),
      y: Math.max(8, Math.min(y, window.innerHeight - (target.kind === "file" ? 420 : 320))),
      mode: "actions",
    });
    setError("");
  }

  function onContextMenu(
    event: MouseEvent,
    target: { kind: "file"; file: File } | { kind: "folder"; folder: Folder },
  ) {
    event.preventDefault();
    showMenu(target, event.clientX, event.clientY);
  }

  function menuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next].focus();
  }

  async function perform(
    action: () => Promise<{ error?: string }>,
    options: { movedFile?: File; hideFolderId?: string; refresh?: boolean } = {},
  ) {
    setMenu(null);
    setBusy(true);
    setError("");
    const movedFile = options.movedFile;
    const hadPreviousMove = movedFile ? Object.hasOwn(movedFromByFileId, movedFile.id) : false;
    const previousMove = movedFile ? movedFromByFileId[movedFile.id] : null;
    if (movedFile)
      setMovedFromByFileId((current) => ({ ...current, [movedFile.id]: movedFile.folderId }));
    if (options.hideFolderId) setHiddenFolderIds((current) => [...current, options.hideFolderId!]);
    try {
      const result = await action();
      if (result.error) throw new Error(result.error);
      if (options.refresh) router.refresh();
      return true;
    } catch (cause) {
      if (movedFile)
        setMovedFromByFileId((current) => {
          const restored = { ...current };
          if (hadPreviousMove) restored[movedFile.id] = previousMove;
          else delete restored[movedFile.id];
          return restored;
        });
      if (options.hideFolderId)
        setHiddenFolderIds((current) => current.filter((id) => id !== options.hideFolderId));
      setError(
        cause instanceof Error ? cause.message : "Could not update this item. Please try again.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function archiveFile(file: File) {
    setMenu(null);
    setError("");
    setHiddenFileIds((current) => [...current, file.id]);
    try {
      const result = await setDesignFileArchived(file.id, !archived);
      if (result.error) throw new Error(result.error);
    } catch (error) {
      setHiddenFileIds((current) => current.filter((id) => id !== file.id));
      setError(
        error instanceof Error ? error.message : "Could not update this file. Please try again.",
      );
    }
  }

  async function deleteFile(file: File) {
    setBusy(true);
    setError("");
    setHiddenFileIds((current) => [...current, file.id]);
    try {
      const result = await deleteArchivedDesignFile(file.id);
      if (result.error) throw new Error(result.error);
    } catch (cause) {
      setHiddenFileIds((current) => current.filter((id) => id !== file.id));
      setError(cause instanceof Error ? cause.message : "Could not delete this file.");
    } finally {
      setBusy(false);
    }
  }

  function createFolder() {
    setFolderDraft("");
    setCreatingFolder(true);
  }

  function rename(target: RenameTarget) {
    setMenu(null);
    setRenameDraft(
      target.kind === "file"
        ? (renamedFiles[target.file.id] ?? target.file.name)
        : (renamedFolders[target.folder.id] ?? target.folder.name),
    );
    setRenaming(target);
  }

  async function finishFolder() {
    setCreatingFolder(false);
    if (cancelFolderRef.current) {
      cancelFolderRef.current = false;
      return;
    }
    const name = folderDraft.trim();
    if (!name) return;
    const temporaryId = `pending-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    setAddedFolders((current) => [
      {
        id: temporaryId,
        name,
        updatedAt: now,
        createdAt: now,
        creatorName: "You",
        creatorImage: null,
      },
      ...current,
    ]);
    setBusy(true);
    setError("");
    try {
      const result = await createDesignFolder(name);
      if (!result.id) throw new Error(result.error ?? "Could not create the folder.");
      setAddedFolders((current) =>
        current.map((folder) =>
          folder.id === temporaryId ? { ...folder, id: result.id! } : folder,
        ),
      );
    } catch (cause) {
      setAddedFolders((current) => current.filter((folder) => folder.id !== temporaryId));
      setError(cause instanceof Error ? cause.message : "Could not create the folder.");
    } finally {
      setBusy(false);
    }
  }

  async function duplicateFolder(folder: Folder) {
    const temporaryId = `pending-${crypto.randomUUID()}`;
    setMenu(null);
    setError("");
    setAddedFolders((current) => [
      { ...folder, id: temporaryId, name: `${folder.name.slice(0, 115)} copy` },
      ...current,
    ]);
    try {
      const result = await duplicateDesignFolder(folder.id);
      if (!result.id) throw new Error(result.error ?? "Could not duplicate the folder.");
      setAddedFolders((current) =>
        current.map((item) => (item.id === temporaryId ? { ...item, id: result.id! } : item)),
      );
    } catch (cause) {
      setAddedFolders((current) => current.filter((item) => item.id !== temporaryId));
      setError(cause instanceof Error ? cause.message : "Could not duplicate the folder.");
    }
  }

  async function duplicateFile(file: File) {
    const temporaryId = `pending-${crypto.randomUUID()}`;
    setMenu(null);
    setError("");
    setAddedFiles((current) => [
      { ...file, id: temporaryId, name: `${file.name.slice(0, 115)} copy` },
      ...current,
    ]);
    try {
      const result = await duplicateDesignFile(file.id);
      if (!result.id) throw new Error(result.error ?? "Could not duplicate the file.");
      setAddedFiles((current) =>
        archived
          ? current.filter((item) => item.id !== temporaryId)
          : current.map((item) => (item.id === temporaryId ? { ...item, id: result.id! } : item)),
      );
    } catch (cause) {
      setAddedFiles((current) => current.filter((item) => item.id !== temporaryId));
      setError(cause instanceof Error ? cause.message : "Could not duplicate the file.");
    }
  }

  async function finishRename() {
    const target = renaming;
    setRenaming(null);
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return;
    }
    const name = renameDraft.trim();
    if (!target || !name) return;
    if (target.kind === "file") {
      const file = target.file;
      if (name === file.name) return;
      setRenamedFiles((current) => ({ ...current, [file.id]: name }));
      const success = await perform(() => renameDesignFile(file.id, name));
      if (!success) setRenamedFiles((current) => ({ ...current, [file.id]: file.name }));
    } else {
      const folder = target.folder;
      if (name === folder.name) return;
      setRenamedFolders((current) => ({ ...current, [folder.id]: name }));
      const success = await perform(() => renameDesignFolder(folder.id, name));
      if (!success) setRenamedFolders((current) => ({ ...current, [folder.id]: folder.name }));
    }
  }

  function fileListRow(file: File, nested = false) {
    return (
      <li
        key={file.id}
        aria-busy={file.id.startsWith("pending-")}
        className={`${listColumns} min-h-24 ${file.id.startsWith("pending-") ? "pointer-events-none opacity-60" : ""} rounded-lg px-3 py-2 transition-colors hover:bg-primary-grey/15`}
        onContextMenu={(event) => onContextMenu(event, { kind: "file", file })}
      >
        <div className={`flex min-w-0 items-center gap-4 ${nested ? "pl-8" : ""}`}>
          <Link
            prefetchOnIntent
            href={`/files/${encodeURIComponent(file.id)}`}
            aria-label={`Open ${file.name}`}
            className="block h-16 w-24 shrink-0 overflow-hidden rounded-md bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange"
          >
            <FileThumbnail
              key={`${file.id}:${file.updatedAt}`}
              fileId={file.id}
              initialVersion={fileVersion(file.updatedAt, file.documentRevision)}
              thumbnailVersion={file.thumbnailVersion}
              canGenerate={canEdit}
              cacheScope={thumbnailScope}
              eager={sortedFiles.slice(0, 3).includes(file)}
            />
          </Link>
          {renaming?.kind === "file" && renaming.file.id === file.id ? (
            <input
              aria-label="File name"
              autoFocus
              maxLength={120}
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={() => void finishRename()}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  cancelRenameRef.current = true;
                  event.currentTarget.blur();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-primary-orange"
            />
          ) : (
            <Link
              prefetchOnIntent
              href={`/files/${encodeURIComponent(file.id)}`}
              className="truncate text-sm font-medium hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-primary-orange"
            >
              {renamedFiles[file.id] ?? file.name}
            </Link>
          )}
        </div>
        <DateCell value={file.updatedAt} asOf={asOf} className="hidden sm:block" />
        <DateCell value={file.createdAt} asOf={asOf} className="hidden lg:block" />
        <CreatorCell name={file.creatorName} />
        <span className="hidden text-sm text-secondary-ink xl:block">—</span>
        <button
          type="button"
          aria-label={`Actions for ${file.name}`}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            showMenu({ kind: "file", file }, bounds.right - 216, bounds.bottom + 4);
          }}
          className="rounded p-1 text-secondary-ink hover:bg-primary-grey/25 hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange"
        >
          <Icon name="more" />
        </button>
      </li>
    );
  }

  return (
    <FileThumbnailUpdates>
      {currentFolder && (
        <Link
          prefetchOnIntent
          href="/files"
          className="mb-5 inline-flex items-center gap-2 text-sm text-secondary-ink hover:text-primary-black"
        >
          <Icon name="back" size={16} /> Files
        </Link>
      )}
      <div className={filesHeader}>
        <h1 className="min-w-0 truncate text-3xl font-semibold tracking-tight">
          {archived ? "Archive" : (currentFolder?.name ?? "Files")}
        </h1>
        <div className="flex items-center gap-2">
          {canEdit && !archived && (
            <>
              <NewFileButton folderId={currentFolder?.id ?? null} />
              {!currentFolder && (
                <button
                  type="button"
                  onClick={createFolder}
                  disabled={busy || creatingFolder}
                  className="rounded-lg border border-primary-grey px-4 py-2.5 text-sm font-medium hover:bg-surface/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange disabled:opacity-50"
                >
                  + New folder
                </button>
              )}
            </>
          )}
          <div
            role="group"
            aria-label="File view"
            className="flex rounded-lg border border-primary-grey/70 p-1"
          >
            <button
              type="button"
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              onClick={() => changeView("grid")}
              className={`rounded-md p-2 focus-visible:outline-2 focus-visible:outline-primary-orange ${view === "grid" ? "bg-primary-grey/35" : "text-secondary-ink hover:bg-primary-grey/20"}`}
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 18 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="2" y="2" width="5" height="5" rx="1" />
                <rect x="11" y="2" width="5" height="5" rx="1" />
                <rect x="2" y="11" width="5" height="5" rx="1" />
                <rect x="11" y="11" width="5" height="5" rx="1" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => changeView("list")}
              className={`rounded-md p-2 focus-visible:outline-2 focus-visible:outline-primary-orange ${view === "list" ? "bg-primary-grey/35" : "text-secondary-ink hover:bg-primary-grey/20"}`}
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 18 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M7 4h9M7 9h9M7 14h9" />
                <path d="M2.5 4h1M2.5 9h1M2.5 14h1" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-5 text-sm text-danger">
          {error}
        </p>
      )}

      {view === "grid" &&
        !archived &&
        !currentFolder &&
        (visibleFolders.length > 0 || creatingFolder) && (
          <ul className={filesGrid}>
            {creatingFolder && (
              <li>
                <div className="flex h-24 items-center gap-4 rounded-xl border border-primary-orange px-5">
                  <Icon name="folder" size={28} />
                  <input
                    aria-label="New folder name"
                    autoFocus
                    value={folderDraft}
                    onChange={(event) => setFolderDraft(event.target.value)}
                    onBlur={finishFolder}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        cancelFolderRef.current = true;
                        event.currentTarget.blur();
                      }
                    }}
                    maxLength={120}
                    placeholder="Folder name"
                    className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-secondary-ink"
                  />
                </div>
              </li>
            )}
            {visibleFolders.map((folder) => (
              <li
                key={folder.id}
                aria-busy={folder.id.startsWith("pending-")}
                className={`relative ${folder.id.startsWith("pending-") ? "pointer-events-none opacity-60" : ""}`}
                onContextMenu={(event) => onContextMenu(event, { kind: "folder", folder })}
              >
                {renaming?.kind === "folder" && renaming.folder.id === folder.id ? (
                  <div className={folderCard}>
                    <Icon name="folder" size={28} className="opacity-65" />
                    <input
                      aria-label="Folder name"
                      autoFocus
                      maxLength={120}
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={() => void finishRename()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          cancelRenameRef.current = true;
                          event.currentTarget.blur();
                        }
                      }}
                      className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-primary-orange"
                    />
                  </div>
                ) : (
                  <Link
                    prefetchOnIntent
                    href={`/files?folder=${encodeURIComponent(folder.id)}`}
                    className={`${folderCard} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange`}
                  >
                    <Icon name="folder" size={28} className="opacity-65" />
                    <span className="truncate text-sm font-medium">
                      {renamedFolders[folder.id] ?? folder.name}
                    </span>
                  </Link>
                )}
                <button
                  type="button"
                  aria-label={`Actions for folder ${folder.name}`}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    showMenu({ kind: "folder", folder }, bounds.right - 216, bounds.bottom + 4);
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-secondary-ink hover:bg-primary-grey/25 hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange"
                >
                  <Icon name="more" />
                </button>
              </li>
            ))}
          </ul>
        )}

      {view === "list" && (
        <div className="pt-9">
          <div
            className={`${listColumns} border-b border-primary-grey/60 px-3 pb-3 text-xs font-medium text-secondary-ink`}
          >
            <span>Name</span>
            <button
              type="button"
              onClick={() => setNewestFirst((current) => !current)}
              aria-label={`Sort by edited, ${newestFirst ? "oldest first" : "newest first"}`}
              className="hidden w-fit items-center gap-1 rounded text-left hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange sm:inline-flex"
            >
              Edited <span aria-hidden="true">{newestFirst ? "▾" : "▴"}</span>
            </button>
            <span className="hidden lg:block">Created</span>
            <span className="hidden lg:block">Created by</span>
            <span className="hidden xl:block">Active in file</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul className="divide-y divide-primary-grey/35">
            {!archived && !currentFolder && creatingFolder && (
              <li className={`${listColumns} min-h-20 px-3 py-2`}>
                <span className="flex min-w-0 items-center gap-4">
                  <Icon name="folder" size={28} className="opacity-65" />
                  <input
                    aria-label="New folder name"
                    autoFocus
                    value={folderDraft}
                    onChange={(event) => setFolderDraft(event.target.value)}
                    onBlur={finishFolder}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        cancelFolderRef.current = true;
                        event.currentTarget.blur();
                      }
                    }}
                    maxLength={120}
                    placeholder="Folder name"
                    className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-secondary-ink"
                  />
                </span>
              </li>
            )}
            {!archived &&
              !currentFolder &&
              sortedFolders.map((folder) => (
                <Fragment key={folder.id}>
                  <li
                    aria-busy={folder.id.startsWith("pending-")}
                    className={`${listColumns} min-h-20 ${folder.id.startsWith("pending-") ? "pointer-events-none opacity-60" : ""} rounded-lg px-3 py-2 transition-colors hover:bg-primary-grey/15`}
                    onContextMenu={(event) => onContextMenu(event, { kind: "folder", folder })}
                  >
                    <div className="flex min-w-0 items-center gap-4">
                      <button
                        type="button"
                        aria-label={`${expandedFolderIds.includes(folder.id) ? "Collapse" : "Expand"} folder ${renamedFolders[folder.id] ?? folder.name}`}
                        aria-expanded={expandedFolderIds.includes(folder.id)}
                        onClick={() => toggleFolder(folder)}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-secondary-ink hover:bg-primary-grey/25 focus-visible:outline-2 focus-visible:outline-primary-orange"
                      >
                        <svg
                          aria-hidden="true"
                          width="16"
                          height="16"
                          viewBox="0 0 16 16"
                          fill="none"
                          className={`transition-transform ${expandedFolderIds.includes(folder.id) ? "rotate-90" : ""}`}
                        >
                          <path
                            d="m6 4 4 4-4 4"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      <span className="flex h-14 w-20 shrink-0 items-center justify-center rounded-md bg-primary-grey/20">
                        <Icon name="folder" size={29} className="opacity-65" />
                      </span>
                      {renaming?.kind === "folder" && renaming.folder.id === folder.id ? (
                        <input
                          aria-label="Folder name"
                          autoFocus
                          maxLength={120}
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={() => void finishRename()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") {
                              cancelRenameRef.current = true;
                              event.currentTarget.blur();
                            }
                          }}
                          className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-primary-orange"
                        />
                      ) : (
                        <Link
                          prefetchOnIntent
                          href={`/files?folder=${encodeURIComponent(folder.id)}`}
                          className="truncate text-sm font-medium hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-primary-orange"
                        >
                          {renamedFolders[folder.id] ?? folder.name}
                        </Link>
                      )}
                    </div>
                    <DateCell value={folder.updatedAt} asOf={asOf} className="hidden sm:block" />
                    <DateCell value={folder.createdAt} asOf={asOf} className="hidden lg:block" />
                    <CreatorCell name={folder.creatorName} />
                    <span className="hidden text-sm text-secondary-ink xl:block">—</span>
                    <button
                      type="button"
                      aria-label={`Actions for folder ${folder.name}`}
                      onClick={(event) => {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        showMenu({ kind: "folder", folder }, bounds.right - 216, bounds.bottom + 4);
                      }}
                      className="rounded p-1 text-secondary-ink hover:bg-primary-grey/25 hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange"
                    >
                      <Icon name="more" />
                    </button>
                  </li>
                  {expandedFolderIds.includes(folder.id) && (
                    <>
                      {visibleFilesInFolder(folder.id).length === 0 && (
                        <li className="py-4 pl-14 text-sm text-secondary-ink">
                          No files in this folder.
                        </li>
                      )}
                      {visibleFilesInFolder(folder.id).map((file) => fileListRow(file, true))}
                    </>
                  )}
                </Fragment>
              ))}
            {sortedFiles.map((file) => fileListRow(file))}
          </ul>
          {visibleFiles.length === 0 &&
            (visibleFolders.length === 0 || archived || currentFolder) &&
            !creatingFolder && (
              <p className="py-7 text-sm text-secondary-ink">
                {archived
                  ? "No archived files."
                  : currentFolder
                    ? "No files in this folder."
                    : "No files yet."}
              </p>
            )}
        </div>
      )}

      {view === "grid" &&
        (visibleFiles.length > 0 ? (
          <ul className={filesGrid}>
            {visibleFiles.map((file, index) => (
              <li
                key={file.id}
                aria-busy={file.id.startsWith("pending-")}
                className={`relative ${file.id.startsWith("pending-") ? "pointer-events-none opacity-60" : ""}`}
                onContextMenu={(event) => onContextMenu(event, { kind: "file", file })}
              >
                <div className="group relative overflow-hidden rounded-xl border border-primary-grey/70 transition-colors hover:border-primary-grey hover:bg-surface/40">
                  {!(renaming?.kind === "file" && renaming.file.id === file.id) && (
                    <Link
                      prefetchOnIntent
                      href={`/files/${encodeURIComponent(file.id)}`}
                      aria-label={`Open ${renamedFiles[file.id] ?? file.name}`}
                      className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-orange"
                    />
                  )}
                  <div className="h-44 border-b border-primary-grey/45">
                    <FileThumbnail
                      key={`${file.id}:${file.updatedAt}`}
                      fileId={file.id}
                      initialVersion={fileVersion(file.updatedAt, file.documentRevision)}
                      thumbnailVersion={file.thumbnailVersion}
                      canGenerate={canEdit}
                      cacheScope={thumbnailScope}
                      eager={index < 3}
                    />
                  </div>
                  <div className="p-4 pr-12">
                    {renaming?.kind === "file" && renaming.file.id === file.id ? (
                      <input
                        aria-label="File name"
                        autoFocus
                        maxLength={120}
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onFocus={(event) => event.currentTarget.select()}
                        onBlur={() => void finishRename()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") {
                            cancelRenameRef.current = true;
                            event.currentTarget.blur();
                          }
                        }}
                        className="relative z-20 w-full min-w-0 bg-transparent text-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-primary-orange"
                      />
                    ) : (
                      <span className="block truncate text-sm font-medium group-hover:text-accent-ink">
                        {renamedFiles[file.id] ?? file.name}
                      </span>
                    )}
                    <p className="mt-1 text-xs text-secondary-ink">
                      {file.nodeCount
                        ? `${file.nodeCount} layers`
                        : `${file.frameCount} ${file.frameCount === 1 ? "frame" : "frames"} · ${file.rectangleCount} ${file.rectangleCount === 1 ? "rectangle" : "rectangles"}`}{" "}
                      ·{" "}
                      {new Date(file.updatedAt).toLocaleDateString("en-IE", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Actions for ${file.name}`}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    showMenu({ kind: "file", file }, bounds.right - 216, bounds.bottom + 4);
                  }}
                  className="absolute bottom-3 right-3 z-20 rounded p-1 text-secondary-ink hover:bg-primary-grey/25 hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange"
                >
                  <Icon name="more" />
                </button>
              </li>
            ))}
          </ul>
        ) : (visibleFolders.length === 0 && !creatingFolder) || archived || currentFolder ? (
          <p className="pt-9 text-sm text-secondary-ink">
            {archived
              ? "No archived files."
              : currentFolder
                ? "No files in this folder."
                : "No files yet."}
          </p>
        ) : null)}

      {menu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${menu.kind === "file" ? menu.file.name : menu.folder.name}`}
          onKeyDown={menuKeyDown}
          className="fixed z-50 max-h-[calc(100dvh-1rem)] w-56 overflow-y-auto rounded-xl border border-primary-grey/70 bg-primary-white p-2 text-primary-black shadow-xl"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.kind === "folder" ? (
            <>
              <button
                type="button"
                role="menuitem"
                autoFocus
                className={menuItem}
                onClick={() => router.push(`/files?folder=${encodeURIComponent(menu.folder.id)}`)}
              >
                Open
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  window.open(
                    `/files?folder=${encodeURIComponent(menu.folder.id)}`,
                    "_blank",
                    "noopener,noreferrer",
                  );
                  setMenu(null);
                }}
              >
                Open in new tab
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(
                      `${window.location.origin}/files?folder=${encodeURIComponent(menu.folder.id)}`,
                    )
                    .catch(() => setError("Could not copy the link."));
                  setMenu(null);
                }}
              >
                Copy link
              </button>
              {canEdit && (
                <>
                  <div className="my-1 border-t border-primary-grey/60" />
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    disabled={busy}
                    onClick={() => rename({ kind: "folder", folder: menu.folder })}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    disabled={busy}
                    onClick={() => void duplicateFolder(menu.folder)}
                  >
                    Duplicate
                  </button>
                  <div className="my-1 border-t border-primary-grey/60" />
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    disabled={busy}
                    onClick={() => {
                      setMenu(null);
                      setDeletingFolder(menu.folder);
                    }}
                  >
                    Delete folder
                  </button>
                </>
              )}
            </>
          ) : menu.mode === "move" ? (
            <>
              <button
                type="button"
                role="menuitem"
                autoFocus
                className={menuItem}
                onClick={() => setMenu({ ...menu, mode: "actions" })}
              >
                ← Back
              </button>
              <div className="my-1 border-t border-primary-grey/60" />
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                disabled={busy}
                onClick={() =>
                  void perform(() => moveDesignFile(menu.file.id, null), {
                    movedFile: menu.file.folderId ? menu.file : undefined,
                  })
                }
              >
                Files
              </button>
              {visibleFolders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  disabled={busy}
                  onClick={() =>
                    void perform(() => moveDesignFile(menu.file.id, folder.id), {
                      movedFile: menu.file,
                    })
                  }
                >
                  {folder.name}
                </button>
              ))}
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                autoFocus
                className={menuItem}
                onClick={() => router.push(`/files/${encodeURIComponent(menu.file.id)}`)}
              >
                Open
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  window.open(`/files/${menu.file.id}`, "_blank", "noopener,noreferrer");
                  setMenu(null);
                }}
              >
                Open in new tab
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(`${window.location.origin}/files/${menu.file.id}`)
                    .catch(() => setError("Could not copy the link."));
                  setMenu(null);
                }}
              >
                Copy link
              </button>
              {canEdit && (
                <>
                  <div className="my-1 border-t border-primary-grey/60" />
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    disabled={busy}
                    onClick={() => rename({ kind: "file", file: menu.file })}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    disabled={busy}
                    onClick={() => void duplicateFile(menu.file)}
                  >
                    Duplicate
                  </button>
                  {!archived && (
                    <button
                      type="button"
                      role="menuitem"
                      className={menuItem}
                      disabled={busy}
                      onClick={() => setMenu({ ...menu, mode: "move" })}
                    >
                      Move to…
                    </button>
                  )}
                  <div className="my-1 border-t border-primary-grey/60" />
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    onClick={() => void archiveFile(menu.file)}
                  >
                    {archived ? "Restore" : "Archive"}
                  </button>
                  {archived && (
                    <button
                      type="button"
                      role="menuitem"
                      className={menuItem}
                      disabled={busy}
                      onClick={() => {
                        setMenu(null);
                        setDeletingFile(menu.file);
                      }}
                    >
                      Delete permanently
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      <Dialog
        ref={deleteDialogRef}
        aria-labelledby="delete-folder-title"
        aria-describedby="delete-folder-description"
        onClose={() => {
          setDeletingFolder(null);
          setDeletingFile(null);
        }}
        padded={false}
      >
        <div className="px-6 pb-6 pt-7">
          <h2 id="delete-folder-title" className="text-xl font-semibold tracking-tight">
            {deletingFile ? "Delete file permanently?" : "Delete folder?"}
          </h2>
          <p id="delete-folder-description" className="mt-3 text-sm leading-6 text-secondary-ink">
            {deletingFile && (
              <>
                “{deletingFile.name}” and its design history, comments and reviews will be
                permanently deleted. This cannot be undone.
              </>
            )}
            {deletingFolder && (
              <>
                “{deletingFolder.name}” will be deleted. Active files inside will move to Files.
                Archived files will stay in Archive.
              </>
            )}
          </p>
          <div className="mt-7 flex justify-end gap-3">
            <button
              type="button"
              autoFocus
              onClick={() => deleteDialogRef.current?.close()}
              className="rounded-lg border border-primary-grey px-4 py-2.5 text-sm font-medium hover:bg-primary-grey/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || (!deletingFolder && !deletingFile)}
              onClick={() => {
                if (deletingFile) {
                  const file = deletingFile;
                  deleteDialogRef.current?.close();
                  void deleteFile(file);
                  return;
                }
                const folder = deletingFolder;
                if (!folder) return;
                deleteDialogRef.current?.close();
                void perform(() => deleteDesignFolder(folder.id), {
                  hideFolderId: folder.id,
                  refresh: true,
                });
              }}
              className="rounded-lg bg-danger-fill px-4 py-2.5 text-sm font-medium text-on-danger hover:bg-danger-fill-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange disabled:opacity-50"
            >
              {deletingFile ? "Delete permanently" : "Delete folder"}
            </button>
          </div>
        </div>
      </Dialog>
    </FileThumbnailUpdates>
  );
}
