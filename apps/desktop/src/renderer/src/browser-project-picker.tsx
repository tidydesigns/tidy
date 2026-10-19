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

function ProjectPicker({
  open,
  finish,
}: {
  open(path: string): Promise<ProjectSnapshot>;
  finish(project: ProjectSnapshot | null): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigation = useRef(0);
  const cache = useRef(new Map<string, Directory>());

  async function load(path?: string) {
    const response = await fetch(
      `/__tidy/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    );
    const result = (await response.json()) as
      | { ok: true; data: Directory }
      | { ok: false; error: string };
    if (!result.ok) throw new Error(result.error);
    cache.current.set(result.data.path, result.data);
    return result.data;
  }
  async function browse(path?: string) {
    const generation = ++navigation.current;
    setError("");
    setBusy(true);
    try {
      const next = (path && cache.current.get(path)) || (await load(path));
      if (navigation.current !== generation) return;
      setDirectory(next);
      setPath(next.path);
    } catch (error) {
      if (navigation.current === generation)
        setError(error instanceof Error ? error.message : "Unable to open folder.");
    } finally {
      if (navigation.current === generation) setBusy(false);
    }
  }
  useEffect(() => {
    dialog.current?.showModal();
    void browse();
    return () => {
      navigation.current++;
    };
    // Only initialise the picker once; subsequent navigation is explicit.
  }, []);

  async function select() {
    if (!directory || busy) return;
    setBusy(true);
    setError("");
    try {
      finish(await open(path.trim()));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to open project.");
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="browser-project-dialog"
      aria-labelledby="browser-project-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) finish(null);
      }}
    >
      <h2 id="browser-project-title">Open project</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void browse(path);
        }}
      >
        <label htmlFor="browser-project-path">Folder on Linux</label>
        <div className="browser-project-path">
          <input
            id="browser-project-path"
            value={path}
            autoFocus
            spellCheck={false}
            placeholder="/home/…/my-project"
            onChange={(event) => setPath(event.target.value)}
          />
          <Button type="submit" className="secondary-button" disabled={busy || !path.trim()}>
            Go
          </Button>
        </div>
      </form>
      <div className="browser-project-navigation">
        <Button
          className="secondary-button"
          disabled={busy || !directory?.parent}
          onClick={() => void browse(directory?.parent ?? undefined)}
        >
          Parent folder
        </Button>
      </div>
      <div className="browser-project-folders" aria-label="Linux folders" aria-busy={busy}>
        {directory?.directories.map((folder) => (
          <Button
            key={folder.path}
            className="browser-project-folder"
            disabled={busy}
            onPointerEnter={() => {
              if (!cache.current.has(folder.path)) void load(folder.path).catch(() => {});
            }}
            onFocus={() => {
              if (!cache.current.has(folder.path)) void load(folder.path).catch(() => {});
            }}
            onClick={() => void browse(folder.path)}
          >
            {folder.name}
            <span aria-hidden="true">›</span>
          </Button>
        ))}
        {!directory && busy && <p>Loading folders…</p>}
        {directory && !directory.directories.length && <p>No subfolders</p>}
      </div>
      {error && (
        <p className="browser-project-error" role="alert">
          {error}
        </p>
      )}
      <div className="browser-project-actions">
        <Button className="secondary-button" disabled={busy} onClick={() => finish(null)}>
          Cancel
        </Button>
        <Button
          className="primary-button"
          disabled={busy || !directory}
          onClick={() => void select()}
        >
          Open folder
        </Button>
      </div>
    </dialog>
  );
}

export function chooseBrowserProject(
  open: (path: string) => Promise<ProjectSnapshot>,
): Promise<ProjectSnapshot | null> {
  const previousFocus = document.activeElement;
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
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
      resolve(project);
    }
    root.render(<ProjectPicker open={open} finish={finish} />);
  });
}
