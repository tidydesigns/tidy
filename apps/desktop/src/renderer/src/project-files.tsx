import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { Icon } from "@tidy/editor/components/ui/icon";
import {
  FileCard,
  FileViewToggle,
  folderCardClass,
} from "@tidy/editor/components/files/file-browser-ui";
import { DocumentPreview } from "@tidy/editor/components/files/document-preview";
import { filesGrid, filesHeader } from "@tidy/editor/components/workspace/page-layout";
import type {
  DesktopAPI,
  DesignFolder,
  DesignSummary,
  LocalDesign,
  ProjectSnapshot,
} from "../../shared/contracts";

function LocalPreview({
  api,
  projectId,
  file,
}: {
  api: DesktopAPI;
  projectId: string;
  file: DesignSummary;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [value, setValue] = useState<LocalDesign>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    void api
      .readDesign(projectId, file.id)
      .then((value) => {
        if (current) {
          setValue(value);
          setError(false);
        }
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
    };
  }, [api, projectId, file.id, file.updatedAt, visible]);
  return (
    <div ref={container} className="local-file-preview" aria-hidden="true">
      {value ? (
        <DocumentPreview content={value.document} assetUrl={(id) => value.assets[id] ?? ""} />
      ) : error ? (
        <Icon name="frame" size={24} />
      ) : null}
    </div>
  );
}

type Editing = { kind: "create" } | { kind: "folder" | "file"; id: string };
export function ProjectFiles({
  api,
  snapshot,
  onOpen,
  onCreated,
  onUpdate,
  onFolderUpdate,
}: {
  api: DesktopAPI;
  snapshot: ProjectSnapshot;
  onOpen(id: string): void;
  onCreated(file: LocalDesign): void;
  onUpdate(file: LocalDesign): void;
  onFolderUpdate(folder: DesignFolder): void;
}) {
  const projectId = snapshot.project.id;
  const [folderId, setFolderId] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem("tidy:design-file-view") === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [moving, setMoving] = useState<string | null>(null);
  const [moves, setMoves] = useState<Record<string, string | null>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const finishing = useRef(false);
  const cancelled = useRef(false);
  const folders = snapshot.folders ?? [];
  const currentFolder = folders.find((item) => item.id === folderId);
  const activeFolderId = currentFolder?.id ?? null;
  const displayName = (item: { id: string; name: string }) => renamed[item.id] ?? item.name;
  function fileFolder(file: DesignSummary) {
    const id = Object.hasOwn(moves, file.id) ? moves[file.id] : file.folderId;
    return folders.some((folder) => folder.id === id) ? id : null;
  }
  const files = snapshot.designs.filter((file) => fileFolder(file) === activeFolderId);
  const openFolder = (id: string | null) => {
    setFolderId(id);
    setError("");
    setEditing(null);
  };
  function edit(value: Editing, initial = "") {
    cancelled.current = false;
    setError("");
    setEditing(value);
    setName(initial);
  }
  async function finishName() {
    if (cancelled.current || finishing.current || !editing) return;
    const target = editing,
      next = name.trim();
    if (!next) {
      setEditing(null);
      return;
    }
    finishing.current = true;
    setPending(true);
    setError("");
    if (target.kind !== "create") {
      setRenamed((current) => ({ ...current, [target.id]: next }));
      setEditing(null);
    }
    try {
      if (target.kind === "create") onFolderUpdate(await api.createDesignFolder(projectId, next));
      else if (target.kind === "folder")
        onFolderUpdate(await api.renameDesignFolder(projectId, target.id, next));
      else {
        const file = await api.readDesign(projectId, target.id);
        onUpdate(
          await api.updateDesign({
            projectId,
            designId: file.id,
            expectedVersion: file.version,
            name: next,
          }),
        );
      }
      if (target.kind !== "create")
        setRenamed((current) => {
          const next = { ...current };
          delete next[target.id];
          return next;
        });
      setEditing(null);
    } catch (cause) {
      if (target.kind !== "create")
        setRenamed((current) => {
          const next = { ...current };
          delete next[target.id];
          return next;
        });
      setError(cause instanceof Error ? cause.message : "Could not rename this item.");
    } finally {
      finishing.current = false;
      setPending(false);
    }
  }
  function inputKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      cancelled.current = true;
      setEditing(null);
    }
  }
  function nameField() {
    return (
      <input
        className="file-name-input"
        aria-label={editing?.kind === "create" ? "New folder name" : "Name"}
        autoFocus
        maxLength={120}
        value={name}
        disabled={pending}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={inputKey}
        onBlur={() => void finishName()}
      />
    );
  }
  async function create(importing = false) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const file = importing
        ? await api.importDesign(projectId, activeFolderId)
        : await api.createDesign(projectId, activeFolderId);
      if (file) onCreated(file);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create this file.");
    } finally {
      setPending(false);
    }
  }
  async function move(file: DesignSummary, nextFolderId: string | null) {
    setMoving(null);
    if (fileFolder(file) === nextFolderId) return;
    setMoves((current) => ({ ...current, [file.id]: nextFolderId }));
    setPending(true);
    setError("");
    try {
      const current = await api.readDesign(projectId, file.id);
      onUpdate(
        await api.updateDesign({
          projectId,
          designId: file.id,
          expectedVersion: current.version,
          folderId: nextFolderId,
        }),
      );
      setMoves((current) => {
        const next = { ...current };
        delete next[file.id];
        return next;
      });
    } catch (cause) {
      setMoves((current) => {
        const next = { ...current };
        delete next[file.id];
        return next;
      });
      setError(cause instanceof Error ? cause.message : "Could not move this file.");
    } finally {
      setPending(false);
    }
  }
  const date = (value: string) =>
    new Date(value).toLocaleDateString("en-IE", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  function fileMenu(file: DesignSummary) {
    return (
      <SelectMenu
        actionMenu
        className="file-action-menu"
        label={`Actions for ${displayName(file)}`}
        value=""
        placement="bottom"
        triggerClassName="file-actions"
        triggerContent={<Icon name="more" />}
        disabled={pending}
        options={[
          { value: "rename", label: "Rename" },
          { value: "move", label: "Move to…" },
        ]}
        onChange={(value) =>
          value === "rename"
            ? edit({ kind: "file", id: file.id }, displayName(file))
            : setMoving(file.id)
        }
      />
    );
  }
  function fileItem(file: DesignSummary, nested = false) {
    const renaming = editing?.kind === "file" && editing.id === file.id;
    const title: ReactNode = renaming ? (
      nameField()
    ) : (
      <span className="block truncate text-sm font-medium">{displayName(file)}</span>
    );
    const preview = <LocalPreview api={api} projectId={projectId} file={file} />;
    return view === "grid" ? (
      <li key={file.id} className="relative local-file-card">
        <FileCard
          preview={preview}
          openLink={
            !renaming && (
              <Button
                className="file-open-overlay"
                aria-label={`Open ${displayName(file)}`}
                onClick={() => onOpen(file.id)}
              />
            )
          }
        >
          {title}
          <div className="file-card-meta">
            <span>{file.nodeCount ?? 0} layers</span>
            <time dateTime={file.updatedAt}>{date(file.updatedAt)}</time>
          </div>
        </FileCard>
        {fileMenu(file)}
      </li>
    ) : (
      <li key={file.id} className={`local-file-row ${nested ? "nested" : ""}`}>
        <div className="file-row-name">
          <Button
            className="file-row-preview"
            aria-label={`Open ${displayName(file)}`}
            onClick={() => onOpen(file.id)}
          >
            {preview}
          </Button>
          {renaming ? (
            title
          ) : (
            <Button className="file-row-title" onClick={() => onOpen(file.id)}>
              {title}
            </Button>
          )}
        </div>
        <span className="file-layer-count">{file.nodeCount ?? 0} layers</span>
        <time dateTime={file.updatedAt}>{date(file.updatedAt)}</time>
        {fileMenu(file)}
      </li>
    );
  }
  function folderItem(folder: DesignFolder) {
    const renaming = editing?.kind === "folder" && editing.id === folder.id;
    const children = snapshot.designs.filter((file) => fileFolder(file) === folder.id);
    const isExpanded = expanded.has(folder.id);
    return (
      <li key={folder.id} className={`local-folder ${view === "list" ? "local-folder-list" : ""}`}>
        <div className="relative">
          {renaming ? (
            <div className={view === "grid" ? folderCardClass : "folder-list-button"}>
              <Icon name="folder" size={26} />
              {nameField()}
            </div>
          ) : (
            <Button
              className={
                view === "grid" ? `${folderCardClass} w-full text-left` : "folder-list-button"
              }
              aria-label={
                view === "grid"
                  ? `Open folder ${displayName(folder)}`
                  : `${isExpanded ? "Collapse" : "Expand"} folder ${displayName(folder)}`
              }
              aria-expanded={view === "list" ? isExpanded : undefined}
              onClick={() =>
                view === "grid"
                  ? openFolder(folder.id)
                  : setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(folder.id)) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    })
              }
            >
              {view === "list" && (
                <span
                  className={`folder-chevron ${isExpanded ? "expanded" : ""}`}
                  aria-hidden="true"
                >
                  ›
                </span>
              )}
              <Icon name="folder" size={view === "grid" ? 26 : 22} />
              <span className="truncate">{displayName(folder)}</span>
            </Button>
          )}
          <SelectMenu
            actionMenu
            className="file-action-menu"
            label={`Actions for ${displayName(folder)}`}
            value=""
            triggerClassName="file-actions folder-actions"
            triggerContent={<Icon name="more" />}
            disabled={pending}
            options={[{ value: "rename", label: "Rename" }]}
            onChange={() => edit({ kind: "folder", id: folder.id }, displayName(folder))}
          />
        </div>
        {view === "list" &&
          isExpanded &&
          (children.length ? (
            <ul className="folder-file-list">{children.map((file) => fileItem(file, true))}</ul>
          ) : (
            <p className="folder-empty">No files</p>
          ))}
      </li>
    );
  }
  const movingFile = snapshot.designs.find((file) => file.id === moving);
  return (
    <div className="project-files">
      {currentFolder && (
        <Button className="files-back" onClick={() => openFolder(null)}>
          <Icon name="back" size={16} />
          Files
        </Button>
      )}
      <div className={filesHeader}>
        <h1 className="min-w-0 truncate text-3xl font-semibold tracking-tight">
          {currentFolder ? displayName(currentFolder) : "Files"}
        </h1>
        <div className="file-browser-controls">
          <div className="new-file-control">
            <Button className="new-file-button" disabled={pending} onClick={() => void create()}>
              + New file
            </Button>
            <SelectMenu
              actionMenu
              label="New file options"
              value=""
              triggerClassName="new-file-options"
              disabled={pending}
              options={[{ value: "import", label: "Import design…" }]}
              onChange={() => void create(true)}
            />
          </div>
          {!currentFolder && (
            <Button
              className="new-folder-button"
              disabled={pending || Boolean(editing)}
              onClick={() => edit({ kind: "create" })}
            >
              + New folder
            </Button>
          )}
          <FileViewToggle
            view={view}
            onChange={(next) => {
              setView(next);
              try {
                localStorage.setItem("tidy:design-file-view", next);
              } catch {}
            }}
          />
        </div>
      </div>
      {error && (
        <p className="file-browser-error" role="alert">
          {error}
        </p>
      )}
      {!currentFolder && (folders.length > 0 || editing?.kind === "create") && (
        <ul className={view === "grid" ? filesGrid : "local-folder-rows"}>
          {editing?.kind === "create" && (
            <li>
              <div className={view === "grid" ? folderCardClass : "folder-list-button"}>
                <Icon name="folder" size={26} />
                {nameField()}
              </div>
            </li>
          )}
          {folders.map(folderItem)}
        </ul>
      )}
      {files.length > 0 ? (
        <ul className={view === "grid" ? filesGrid : "local-file-rows"}>
          {files.map((file) => fileItem(file))}
        </ul>
      ) : (
        <p className="files-empty">
          {currentFolder
            ? "No files in this folder"
            : folders.length
              ? "No files outside folders"
              : "No design files yet"}
        </p>
      )}
      {movingFile && (
        <MoveDialog
          file={movingFile}
          folders={folders}
          name={displayName(movingFile)}
          onClose={() => setMoving(null)}
          onMove={(id) => void move(movingFile, id)}
        />
      )}
    </div>
  );
}
function MoveDialog({
  file,
  folders,
  name,
  onClose,
  onMove,
}: {
  file: DesignSummary;
  folders: DesignFolder[];
  name: string;
  onClose(): void;
  onMove(id: string | null): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <Dialog
      ref={ref}
      className="file-move-dialog"
      aria-label={`Move ${name}`}
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="file-move-heading">
        <h2>Move {name}</h2>
        <Button className="quiet-button" aria-label="Close" onClick={onClose}>
          <Icon name="xmark" size={16} />
        </Button>
      </div>
      <div className="file-move-targets">
        <Button className="file-move-target" disabled={!file.folderId} onClick={() => onMove(null)}>
          <Icon name="folder" />
          Files
        </Button>
        {folders.map((folder) => (
          <Button
            key={folder.id}
            className="file-move-target"
            disabled={file.folderId === folder.id}
            onClick={() => onMove(folder.id)}
          >
            <Icon name="folder" />
            {folder.name}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}
