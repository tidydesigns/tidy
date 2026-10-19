import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@tidy/ui/button";
import type { ProjectSnapshot } from "../../shared/contracts";

type Directory = {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  initialProject: string;
};

function folderError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (message.startsWith("ENOENT:") || message.startsWith("ENOTDIR:"))
    return "Folder not found. Check the path and try again.";
  if (message.startsWith("EACCES:") || message.startsWith("EPERM:"))
    return "You don't have permission to open this folder.";
  return message;
}

function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z" strokeLinejoin="round" />
    </svg>
  );
}

function ProjectPicker({
  open,
  finish,
}: {
  open(path: string): Promise<ProjectSnapshot>;
  finish(project: ProjectSnapshot | null): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [home, setHome] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [opening, setOpening] = useState(false);
  const [active, setActive] = useState(0);
  const cache = useRef(new Map<string, Promise<Directory>>());
  const openingRef = useRef(false);

  function load(path = "") {
    const existing = cache.current.get(path);
    if (existing) return existing;
    const request = fetch(`/__tidy/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`)
      .then(async (response) => {
        const result = (await response.json()) as
          | { ok: true; data: Directory }
          | { ok: false; error: string };
        if (!result.ok) throw new Error(result.error);
        return result.data;
      })
      .catch((error: unknown) => {
        cache.current.delete(path);
        throw error;
      });
    cache.current.set(path, request);
    return request;
  }

  const expanded = query.startsWith("~/") ? home + query.slice(1) : query;
  const slash = expanded.lastIndexOf("/");
  const parent = slash < 0 ? home : expanded.slice(0, slash) || "/";
  const filter = expanded.slice(slash + 1).toLocaleLowerCase();
  const ready =
    directory !== null &&
    (directory.path === parent || cache.current.get(parent) === cache.current.get(directory.path));
  const folders = ready
    ? directory.directories.filter((folder) => folder.name.toLocaleLowerCase().includes(filter))
    : [];
  const canGoUp = ready && directory.parent !== null && !filter;
  const count = folders.length + (canGoUp ? 1 : 0);
  const selectedPath = ready
    ? filter
      ? folders.find((folder) => folder.name === expanded.slice(slash + 1))?.path
      : directory.path
    : undefined;

  function browse(path: string) {
    setQuery(path === home ? "~/" : `${path.replace(/\/$/, "")}/`);
    setActive(0);
    input.current?.focus();
  }
  function navigate(index: number) {
    if (!directory || !ready) return;
    if (canGoUp && index === 0) browse(directory.parent!);
    else {
      const folder = folders[index - (canGoUp ? 1 : 0)];
      if (folder) browse(folder.path);
    }
  }
  async function select() {
    if (!selectedPath || openingRef.current || pending) return;
    openingRef.current = true;
    setOpening(true);
    setError("");
    try {
      finish(await open(selectedPath));
    } catch (error) {
      setError(folderError(error, "Unable to open project."));
      openingRef.current = false;
      setOpening(false);
    }
  }

  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
    let cancelled = false;
    void load()
      .then((result) => {
        if (cancelled) return;
        cache.current.set(result.path, Promise.resolve(result));
        setHome(result.path);
        setDirectory(result);
        setQuery((current) => current || "~/");
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(folderError(error, "Unable to load folders."));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!home) return;
    let cancelled = false;
    setError("");
    setPending(true);
    setActive(0);
    void load(parent)
      .then((result) => {
        if (!cancelled) {
          cache.current.set(result.path, cache.current.get(parent)!);
          setDirectory(result);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(folderError(error, "Unable to load folders."));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [home, parent]);

  useEffect(() => {
    dialog.current
      ?.querySelector(`[data-folder-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const highlighted = count ? Math.min(active, count - 1) : 0;
  return (
    <dialog
      ref={dialog}
      className="browser-project-dialog"
      aria-labelledby="browser-project-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!openingRef.current) finish(null);
      }}
    >
      <div className="browser-project-heading">
        <h2 id="browser-project-title">Open project</h2>
        <span>Linux</span>
        <Button
          className="quiet-button"
          aria-label="Close project picker"
          disabled={opening}
          onClick={() => finish(null)}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="m4 4 8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </Button>
      </div>
      <div className="browser-project-search">
        <FolderIcon />
        <input
          ref={input}
          autoFocus
          role="combobox"
          aria-label="Folder on Linux"
          aria-describedby="browser-project-hints"
          aria-autocomplete="list"
          aria-controls="browser-project-folders"
          aria-expanded="true"
          aria-activedescendant={count ? `browser-folder-${highlighted}` : undefined}
          disabled={opening}
          value={query}
          spellCheck={false}
          autoComplete="off"
          placeholder="Type a folder path…"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (count)
                setActive((highlighted + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (event.metaKey || event.ctrlKey) void select();
              else if (count) navigate(highlighted);
              else if (ready && !filter) void select();
            } else if (event.key === "Tab" && !event.shiftKey && filter && folders.length) {
              event.preventDefault();
              navigate(highlighted === 0 && canGoUp ? 1 : highlighted);
            } else if (event.key === "ArrowLeft" && event.altKey && canGoUp) {
              event.preventDefault();
              browse(directory!.parent!);
            }
          }}
        />
      </div>
      <div
        id="browser-project-folders"
        role="listbox"
        tabIndex={-1}
        aria-label="Linux folders"
        aria-busy={pending}
        className="browser-project-folders"
      >
        {canGoUp && (
          <Button
            role="option"
            aria-selected={highlighted === 0}
            id="browser-folder-0"
            data-folder-index={0}
            className="browser-project-folder"
            tabIndex={-1}
            disabled={opening}
            onPointerMove={() => setActive(0)}
            onClick={() => browse(directory.parent!)}
          >
            <span aria-hidden="true">↰</span>
            <span>Parent folder</span>
            <span aria-hidden="true">..</span>
          </Button>
        )}
        {folders.map((folder, index) => {
          const row = index + (canGoUp ? 1 : 0);
          return (
            <Button
              key={folder.path}
              role="option"
              aria-selected={highlighted === row}
              id={`browser-folder-${row}`}
              data-folder-index={row}
              tabIndex={-1}
              className="browser-project-folder"
              disabled={opening}
              onPointerEnter={() => {
                void load(folder.path).catch(() => {});
              }}
              onPointerMove={() => setActive(row)}
              onClick={() => browse(folder.path)}
            >
              <FolderIcon />
              <span title={folder.name}>{folder.name}</span>
              <span aria-hidden="true">›</span>
            </Button>
          );
        })}
        {!home && !error && <p role="status">Loading folders…</p>}
        {ready && !folders.length && <p>{filter ? "No matching folders" : "No subfolders"}</p>}
      </div>
      {error && (
        <p className="browser-project-error" role="alert">
          {error}
        </p>
      )}
      <div className="browser-project-actions">
        <span title={selectedPath}>{selectedPath ?? "Choose a folder on Linux"}</span>
        <Button
          className="primary-button"
          disabled={opening || pending || !selectedPath}
          onClick={() => void select()}
        >
          {opening ? "Opening…" : "Open folder"}
        </Button>
      </div>
      <div className="browser-project-hints" id="browser-project-hints">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>↵</kbd> browse
        </span>
        <span>
          <kbd>tab</kbd> complete
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </div>
    </dialog>
  );
}

export function chooseBrowserProject(
  open: (path: string) => Promise<ProjectSnapshot>,
): Promise<ProjectSnapshot | null> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return new Promise((resolve) => {
    let settled = false;
    function finish(project: ProjectSnapshot | null) {
      if (settled) return;
      settled = true;
      root.unmount();
      host.remove();
      resolve(project);
    }
    root.render(<ProjectPicker open={open} finish={finish} />);
  });
}
