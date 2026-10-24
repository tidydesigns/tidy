"use client";

import { useErrorNotice } from "@/lib/use-error-notice";
import { UserFacingError } from "@tidy/ui/errors";
import {
  FileCard,
  FileViewToggle,
  FileListHeader,
  FileListRow,
  FileListDate,
  FileListCreator,
  type FileListColumn,
  folderCardClass as folderCard,
} from "@tidy/editor/components/files/file-browser-ui";

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
  "block w-full rounded px-3 py-2 text-left text-sm hover:bg-primary-grey/25 focus-visible:bg-hover-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
const listColumns: readonly FileListColumn[] = ["edited", "created", "creator"];

function restoreItemFocus(invoker: HTMLElement | null, heading: HTMLHeadingElement | null) {
  const destination = invoker?.isConnected
    ? invoker
    : (heading?.closest("main")?.querySelector<HTMLButtonElement>("button[data-item-actions]") ??
      heading);
  destination?.focus({ preventScroll: true });
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
    <span className={className}>
      <FileListDate value={value} asOf={asOf} />
    </span>
  );
}

function CreatorCell({ name, image }: { name: string; image: string | null }) {
  return (
    <span className="file-list-cell file-list-creator">
      <FileListCreator name={name} image={image} />
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
  organizationId,
}: {
  files: File[];
  folders: Folder[];
  currentFolder: Folder | null;
  archived: boolean;
  asOf: string;
  canEdit?: boolean;
  thumbnailScope?: string;
  organizationId?: string;
}) {
  const router = useRouter();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [newestFirst, setNewestFirst] = useState(true);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setError] = useErrorNotice("", "file_manage");
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
  const menuInvoker = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const menuOpen = menu !== null;
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const cancelFolderRef = useRef(false);
  const cancelRenameRef = useRef(false);
  const restoreRenameFocus = useRef(false);

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
    if (!menuOpen) return;
    const popup = menuRef.current;
    const heading = headingRef.current;
    function dismiss(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      const active = document.activeElement;
      if (active === document.body || (active instanceof Node && popup?.contains(active))) {
        restoreItemFocus(menuInvoker.current, heading);
      }
    };
  }, [menuOpen]);

  useEffect(() => {
    if ((deletingFolder || deletingFile) && !deleteDialogRef.current?.open)
      deleteDialogRef.current?.showModal();
  }, [deletingFolder, deletingFile]);

  function showMenu(
    target: { kind: "file"; file: File } | { kind: "folder"; folder: Folder },
    x: number,
    y: number,
    invoker?: HTMLElement,
  ) {
    menuInvoker.current =
      invoker ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
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
    const root = event.currentTarget;
    const invoker =
      root instanceof HTMLElement
        ? (root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]') ??
          root.querySelector<HTMLAnchorElement>("a[href]"))
        : null;
    showMenu(target, event.clientX, event.clientY, invoker ?? undefined);
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
    const notifyError = setError("");
    setMenu(null);
    setBusy(true);

    const movedFile = options.movedFile;
    const hadPreviousMove = movedFile ? Object.hasOwn(movedFromByFileId, movedFile.id) : false;
    const previousMove = movedFile ? movedFromByFileId[movedFile.id] : null;
    if (movedFile)
      setMovedFromByFileId((current) => ({ ...current, [movedFile.id]: movedFile.folderId }));
    if (options.hideFolderId) setHiddenFolderIds((current) => [...current, options.hideFolderId!]);
    try {
      const result = await action();
      if (result.error) throw new UserFacingError(result.error);
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
      notifyError(cause, "Could not update this item. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function archiveFile(file: File) {
    const notifyError = setError("");
    setMenu(null);

    setHiddenFileIds((current) => [...current, file.id]);
    try {
      const result = await setDesignFileArchived(file.id, !archived);
      if (result.error) throw new UserFacingError(result.error);
    } catch (error) {
      setHiddenFileIds((current) => current.filter((id) => id !== file.id));
      notifyError(error, "Could not update this file. Please try again.");
    }
  }

  async function deleteFile(file: File) {
    const notifyError = setError("");
    setBusy(true);

    setHiddenFileIds((current) => [...current, file.id]);
    try {
      const result = await deleteArchivedDesignFile(file.id);
      if (result.error) throw new UserFacingError(result.error);
    } catch (cause) {
      setHiddenFileIds((current) => current.filter((id) => id !== file.id));
      notifyError(cause, "Could not delete this file.");
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
    const notifyError = setError("");
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

    try {
      const result = await createDesignFolder(name);
      if (!result.id) throw new UserFacingError(result.error ?? "Could not create the folder.");
      setAddedFolders((current) =>
        current.map((folder) =>
          folder.id === temporaryId ? { ...folder, id: result.id! } : folder,
        ),
      );
    } catch (cause) {
      setAddedFolders((current) => current.filter((folder) => folder.id !== temporaryId));
      notifyError(cause, "Could not create the folder.");
    } finally {
      setBusy(false);
    }
  }

  async function duplicateFolder(folder: Folder) {
    const notifyError = setError("");
    const temporaryId = `pending-${crypto.randomUUID()}`;
    setMenu(null);

    setAddedFolders((current) => [
      { ...folder, id: temporaryId, name: `${folder.name.slice(0, 115)} copy` },
      ...current,
    ]);
    try {
      const result = await duplicateDesignFolder(folder.id);
      if (!result.id) throw new UserFacingError(result.error ?? "Could not duplicate the folder.");
      setAddedFolders((current) =>
        current.map((item) => (item.id === temporaryId ? { ...item, id: result.id! } : item)),
      );
    } catch (cause) {
      setAddedFolders((current) => current.filter((item) => item.id !== temporaryId));
      notifyError(cause, "Could not duplicate the folder.");
    }
  }

  async function duplicateFile(file: File) {
    const notifyError = setError("");
    const temporaryId = `pending-${crypto.randomUUID()}`;
    setMenu(null);

    setAddedFiles((current) => [
      { ...file, id: temporaryId, name: `${file.name.slice(0, 115)} copy` },
      ...current,
    ]);
    try {
      const result = await duplicateDesignFile(file.id);
      if (!result.id) throw new UserFacingError(result.error ?? "Could not duplicate the file.");
      setAddedFiles((current) =>
        archived
          ? current.filter((item) => item.id !== temporaryId)
          : current.map((item) => (item.id === temporaryId ? { ...item, id: result.id! } : item)),
      );
    } catch (cause) {
      setAddedFiles((current) => current.filter((item) => item.id !== temporaryId));
      notifyError(cause, "Could not duplicate the file.");
    }
  }

  async function finishRename() {
    const target = renaming;
    setRenaming(null);
    if (restoreRenameFocus.current) {
      restoreRenameFocus.current = false;
      restoreItemFocus(menuInvoker.current, headingRef.current);
    }
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

  function renameKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || !["Enter", "Escape"].includes(event.key)) return;
    event.preventDefault();
    cancelRenameRef.current = event.key === "Escape";
    restoreRenameFocus.current = true;
    event.currentTarget.blur();
  }

  function fileListRow(file: File, nested = false) {
    return (
      <FileListRow
        columns={listColumns}
        key={file.id}
        aria-busy={file.id.startsWith("pending-")}
        className={file.id.startsWith("pending-") ? "pointer-events-none opacity-60" : ""}
        onContextMenu={(event) => onContextMenu(event, { kind: "file", file })}
      >
        <div className={`file-list-name ${nested ? "pl-8" : ""}`}>
          <Link
            prefetchOnIntent
            href={`/files/${encodeURIComponent(file.id)}`}
            aria-label={`Open ${file.name}`}
            className="file-list-preview focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange"
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
              data-ph-public-label
              aria-label="File name"
              autoFocus
              maxLength={120}
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={() => void finishRename()}
              onKeyDown={renameKeyDown}
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
        <DateCell value={file.updatedAt} asOf={asOf} className="file-list-cell file-list-edited" />
        <DateCell value={file.createdAt} asOf={asOf} className="file-list-cell file-list-created" />
        <CreatorCell name={file.creatorName} image={file.creatorImage} />
        <button
          type="button"
          aria-label={`Actions for ${file.name}`}
          data-item-actions
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "file" && menu.file.id === file.id}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            showMenu(
              { kind: "file", file },
              bounds.right - 216,
              bounds.bottom + 4,
              event.currentTarget,
            );
          }}
          className="rounded p-1 text-secondary-ink hover:bg-primary-grey/25 hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange"
        >
          <Icon name="more" />
        </button>
      </FileListRow>
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
          <Icon name="back" size={16} />{" "}
          <span data-ph-public style={{ display: "contents" }}>
            Files
          </span>
        </Link>
      )}
      <div className={filesHeader}>
        <h1
          ref={headingRef}
          tabIndex={-1}
          data-ph-public
          className="min-w-0 truncate text-3xl font-semibold tracking-tight outline-none"
        >
          {archived ? (
            "Archive"
          ) : currentFolder ? (
            <span data-ph-private>{currentFolder.name}</span>
          ) : (
            "Files"
          )}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && !archived && (
            <>
              <NewFileButton
                organizationId={organizationId}
                folderId={currentFolder?.id ?? null}
                folderName={currentFolder?.name ?? "Files"}
              />
              {!currentFolder && (
                <button
                  type="button"
                  onClick={createFolder}
                  disabled={busy || creatingFolder}
                  className="rounded-lg border border-primary-grey px-4 py-2.5 text-sm font-medium hover:bg-surface/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange disabled:opacity-50"
                >
                  <span data-ph-public>+ New folder</span>
                </button>
              )}
            </>
          )}
          <FileViewToggle view={view} onChange={changeView} />
        </div>
      </div>

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
                    data-ph-public-label
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
                      data-ph-public-label
                      aria-label="Folder name"
                      autoFocus
                      maxLength={120}
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={() => void finishRename()}
                      onKeyDown={renameKeyDown}
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
                  data-item-actions
                  aria-haspopup="menu"
                  aria-expanded={menu?.kind === "folder" && menu.folder.id === folder.id}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    showMenu(
                      { kind: "folder", folder },
                      bounds.right - 216,
                      bounds.bottom + 4,
                      event.currentTarget,
                    );
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
        <div className="file-list">
          <FileListHeader
            columns={listColumns}
            edited={
              <button
                type="button"
                onClick={() => setNewestFirst((current) => !current)}
                aria-label={`Sort by edited, ${newestFirst ? "oldest first" : "newest first"}`}
                className="inline-flex w-fit items-center gap-1 rounded text-left hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange"
              >
                Edited <span aria-hidden="true">{newestFirst ? "▾" : "▴"}</span>
              </button>
            }
          />
          <ul>
            {!archived && !currentFolder && creatingFolder && (
              <FileListRow columns={listColumns}>
                <span className="flex min-w-0 items-center gap-4">
                  <Icon name="folder" size={28} className="opacity-65" />
                  <input
                    data-ph-public-label
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
              </FileListRow>
            )}
            {!archived &&
              !currentFolder &&
              sortedFolders.map((folder) => (
                <Fragment key={folder.id}>
                  <FileListRow
                    columns={listColumns}
                    aria-busy={folder.id.startsWith("pending-")}
                    className={
                      folder.id.startsWith("pending-") ? "pointer-events-none opacity-60" : ""
                    }
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
                          data-ph-public
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
                          data-ph-public-label
                          aria-label="Folder name"
                          autoFocus
                          maxLength={120}
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={() => void finishRename()}
                          onKeyDown={renameKeyDown}
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
                    <DateCell
                      value={folder.updatedAt}
                      asOf={asOf}
                      className="file-list-cell file-list-edited"
                    />
                    <DateCell
                      value={folder.createdAt}
                      asOf={asOf}
                      className="file-list-cell file-list-created"
                    />
                    <CreatorCell name={folder.creatorName} image={folder.creatorImage} />
                    <button
                      type="button"
                      aria-label={`Actions for folder ${folder.name}`}
                      data-item-actions
                      aria-haspopup="menu"
                      aria-expanded={menu?.kind === "folder" && menu.folder.id === folder.id}
                      onClick={(event) => {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        showMenu(
                          { kind: "folder", folder },
                          bounds.right - 216,
                          bounds.bottom + 4,
                          event.currentTarget,
                        );
                      }}
                      className="rounded p-1 text-secondary-ink hover:bg-primary-grey/25 hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange"
                    >
                      <Icon name="more" />
                    </button>
                  </FileListRow>
                  {expandedFolderIds.includes(folder.id) && (
                    <>
                      {visibleFilesInFolder(folder.id).length === 0 && (
                        <li data-ph-public className="py-4 pl-14 text-sm text-secondary-ink">
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
              <p data-ph-public className="py-7 text-sm text-secondary-ink">
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
                <FileCard
                  openLink={
                    !(renaming?.kind === "file" && renaming.file.id === file.id) && (
                      <Link
                        prefetchOnIntent
                        href={`/files/${encodeURIComponent(file.id)}`}
                        aria-label={`Open ${renamedFiles[file.id] ?? file.name}`}
                        className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-orange"
                      />
                    )
                  }
                  preview={
                    <FileThumbnail
                      key={`${file.id}:${file.updatedAt}`}
                      fileId={file.id}
                      initialVersion={fileVersion(file.updatedAt, file.documentRevision)}
                      thumbnailVersion={file.thumbnailVersion}
                      canGenerate={canEdit}
                      cacheScope={thumbnailScope}
                      eager={index < 3}
                    />
                  }
                >
                  {renaming?.kind === "file" && renaming.file.id === file.id ? (
                    <input
                      data-ph-public-label
                      aria-label="File name"
                      autoFocus
                      maxLength={120}
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={() => void finishRename()}
                      onKeyDown={renameKeyDown}
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
                    <span data-ph-public style={{ display: "contents" }}>
                      ·
                    </span>{" "}
                    {new Date(file.updatedAt).toLocaleDateString("en-IE", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                </FileCard>
                <button
                  type="button"
                  aria-label={`Actions for ${file.name}`}
                  data-item-actions
                  aria-haspopup="menu"
                  aria-expanded={menu?.kind === "file" && menu.file.id === file.id}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    showMenu(
                      { kind: "file", file },
                      bounds.right - 216,
                      bounds.bottom + 4,
                      event.currentTarget,
                    );
                  }}
                  className="absolute bottom-3 right-3 z-20 rounded p-1 text-secondary-ink hover:bg-primary-grey/25 hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange"
                >
                  <Icon name="more" />
                </button>
              </li>
            ))}
          </ul>
        ) : (visibleFolders.length === 0 && !creatingFolder) || archived || currentFolder ? (
          <p data-ph-public className="pt-9 text-sm text-secondary-ink">
            {archived
              ? "No archived files."
              : currentFolder
                ? "No files in this folder."
                : "No files yet."}
          </p>
        ) : null)}

      {menu && (
        <div
          key={`${menu.kind}:${menu.kind === "file" ? menu.file.id : menu.folder.id}:${menu.mode}`}
          data-ph-public
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
                  const notifyClipboardError = setError("");
                  void navigator.clipboard
                    .writeText(
                      `${window.location.origin}/files?folder=${encodeURIComponent(menu.folder.id)}`,
                    )
                    .catch((cause) => notifyClipboardError(cause, "Could not copy the link."));
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
                  data-ph-private
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
                  const notifyClipboardError = setError("");
                  void navigator.clipboard
                    .writeText(`${window.location.origin}/files/${menu.file.id}`)
                    .catch((cause) => notifyClipboardError(cause, "Could not copy the link."));
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
          const active = document.activeElement;
          if (active === document.body || deleteDialogRef.current?.contains(active)) {
            restoreItemFocus(menuInvoker.current, headingRef.current);
          }
        }}
        padded={false}
      >
        <div className="px-6 pb-6 pt-7">
          <h2
            data-ph-public
            id="delete-folder-title"
            className="text-xl font-semibold tracking-tight"
          >
            {deletingFile ? "Delete file permanently?" : "Delete folder?"}
          </h2>
          <p id="delete-folder-description" className="mt-3 text-sm leading-6 text-secondary-ink">
            {deletingFile && (
              <>
                &quot;{deletingFile.name}&quot; and its design history, comments and reviews will be
                permanently deleted. This cannot be undone.
              </>
            )}
            {deletingFolder && (
              <>
                &quot;{deletingFolder.name}&quot; will be deleted. Active files inside will move to
                Files. Archived files will stay in Archive.
              </>
            )}
          </p>
          <div className="mt-7 flex justify-end gap-3">
            <button
              data-ph-public
              type="button"
              autoFocus
              onClick={() => deleteDialogRef.current?.close()}
              className="rounded-lg border border-primary-grey px-4 py-2.5 text-sm font-medium hover:bg-primary-grey/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange"
            >
              Cancel
            </button>
            <button
              data-ph-public
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
