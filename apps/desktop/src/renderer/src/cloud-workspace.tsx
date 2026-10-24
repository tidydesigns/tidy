import { useSessionState } from "./session-state";
import { fileBrowserSchema, emptyFileBrowser } from "../../shared/navigation-state";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Icon } from "@tidy/editor/components/ui/icon";
import { FileCard, FileViewToggle } from "@tidy/editor/components/files/file-browser-ui";
import { filesGrid, filesHeader } from "@tidy/editor/components/workspace/page-layout";
import { errorMessage } from "@tidy/ui/errors";
import type { DesktopAPI, DesignSummary, LocalDesign } from "../../shared/contracts";
import type { CloudCatalog, CloudFile, CloudOpened } from "../../shared/cloud-sync";
import type { CloudConnection } from "./use-cloud";
import { LocalCanvas } from "./local-canvas";
import { CloudPreview } from "./cloud-preview";
import { LocalPreview } from "./project-files";
import { SyncStatus } from "./sync-status";

export function CloudWorkspace({
  api,
  cloud,
  organizationId,
  navigationTarget,
  active,
  onCanvasChange,
}: {
  api: DesktopAPI;
  cloud: CloudConnection;
  organizationId: string;
  navigationTarget: HTMLElement | null;
  active: boolean;
  onCanvasChange(focused: boolean): void;
}) {
  const [catalog, setCatalog] = useState<CloudCatalog>();
  const [browser, setBrowser] = useSessionState(
    `cloud:${cloud.state?.accountId}:${organizationId}`,
    fileBrowserSchema,
    emptyFileBrowser,
  );
  const { folder, query, view } = browser;
  const cancelOpening = () => {
    restored.current = true;
    selection.current++;
    setOpening(undefined);
  };
  const setFolder = (folder: string | null) => {
    cancelOpening();
    setBrowser((value) => ({ ...value, folder, query: "", fileId: null }));
  };
  const setQuery = (query: string) => {
    cancelOpening();
    setBrowser((value) => ({ ...value, query, fileId: null }));
  };
  const setView = (view: "grid" | "list") => setBrowser((value) => ({ ...value, view }));
  const restored = useRef(false);
  const [opened, setOpened] = useState<CloudOpened>();
  const [canvasVisible, setCanvasVisible] = useState(false);
  const [localFiles, setLocalFiles] = useState<Record<string, DesignSummary>>({});
  const [opening, setOpening] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const epoch = useRef(0),
    selection = useRef(0);
  const organization = cloud.account?.organizations.find((o) => o.id === organizationId);
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.type !== "designs") return;
        setLocalFiles((current) => ({
          ...current,
          ...Object.fromEntries(event.designs.map((file) => [file.id, file])),
        }));
      }),
    [api],
  );
  const refresh = useRef<() => void>(() => {});
  const refreshCreated = useRef<(organizationId: string, accountId?: string) => void>(() => {});
  useEffect(() => {
    const version = ++epoch.current;
    const accountId = cloud.state?.accountId;
    selection.current++;
    setOpened(undefined);
    setCanvasVisible(false);
    setLocalFiles({});
    onCanvasChange(false);
    setOpening(undefined);
    setCreating(false);
    setCatalog(undefined);
    setError("");
    setOffline(false);
    const remote = api.cloud;
    if (!remote || !organizationId) return;
    let fetching = false;
    let haveCatalog = false;
    let latestRead = 0;
    const readCached = async () => {
      const read = ++latestRead;
      const value = await remote.catalog(organizationId, true);
      if (epoch.current === version && latestRead === read) {
        haveCatalog = true;
        setCatalog(value);
      }
    };
    const update = async () => {
      if (fetching) return;
      fetching = true;
      const read = ++latestRead;
      try {
        const value = await remote.catalog(organizationId);
        if (epoch.current === version) {
          if (latestRead === read) {
            haveCatalog = true;
            setCatalog(value);
          }
          setOffline(false);
          setError("");
        }
      } catch (cause) {
        if (epoch.current === version) {
          setOffline(true);
          if (!haveCatalog)
            setError(errorMessage(cause, "Could not load your files. Try again when online."));
        }
      } finally {
        fetching = false;
      }
    };
    refresh.current = () => void update();
    refreshCreated.current = (createdOrganizationId, createdAccountId) => {
      if (createdOrganizationId === organizationId && createdAccountId === accountId)
        void readCached().catch(() => update());
    };
    void readCached()
      .catch(() => {})
      .then(update);
    return () => {
      epoch.current++;
      selection.current++;
      refreshCreated.current = () => {};
    };
  }, [api, organizationId, cloud.state?.accountId]);
  useEffect(() => {
    if (!active) return;
    const update = () => {
      if (!document.hidden) refresh.current();
    };
    const timer = setInterval(update, 30_000);
    window.addEventListener("focus", update);
    window.addEventListener("online", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
      window.removeEventListener("online", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [active]);
  useEffect(() => () => onCanvasChange(false), [onCanvasChange]);
  useEffect(() => {
    if (!active && creating) {
      selection.current++;
      setCreating(false);
    }
  }, [active]);
  const updateDesign = useCallback(
    (design: LocalDesign) =>
      setOpened((value) => (value?.design.id === design.id ? { ...value, design } : value)),
    [],
  );
  useEffect(() => {
    if (!active || !catalog || restored.current || !browser.fileId) return;
    const file = catalog.files.find((file) => file.id === browser.fileId);
    if (!file) return;
    restored.current = true;
    void open(file);
  }, [active, catalog, browser.fileId]);
  async function open(file: CloudFile) {
    if (!api.cloud || opening === file.id) return;
    restored.current = true;
    setBrowser((current) =>
      current.fileId === file.id ? current : { ...current, fileId: file.id },
    );
    const version = ++selection.current;
    setCreating(false);
    setError("");
    const binding = cloud.state?.bindings.find((binding) => binding.fileId === file.id);
    if (opened && binding?.designId === opened.design.id) {
      setOpening(undefined);
      setCanvasVisible(true);
      onCanvasChange(true);
      return;
    }
    setOpening(file.id);
    try {
      const value = await api.cloud.openFile(organizationId, file.id);
      if (selection.current === version) {
        onCanvasChange(true);
        setOpened(value);
        setCanvasVisible(true);
      }
    } catch (cause) {
      if (selection.current === version) {
        setBrowser((current) => ({ ...current, fileId: null }));
        setError(
          errorMessage(cause, "Could not open this file. Connect to the internet to download it."),
        );
      }
    } finally {
      if (selection.current === version) setOpening(undefined);
    }
  }
  async function create() {
    if (!api.cloud || creating) return;
    const version = ++selection.current;
    const accountId = cloud.state?.accountId;
    setBrowser((current) => ({ ...current, fileId: null }));
    setCreating(true);
    setOpening(undefined);
    setError("");
    try {
      const value = await api.cloud.createFile(organizationId);
      if (selection.current === version) {
        onCanvasChange(true);
        setOpened(value);
        setCanvasVisible(true);
      } else refreshCreated.current(organizationId, accountId);
    } catch (cause) {
      if (selection.current === version)
        setError(errorMessage(cause, "Could not create this file."));
    } finally {
      if (selection.current === version) setCreating(false);
    }
  }
  useEffect(() => {
    if (!opened || !canvasVisible) return;
    const binding = cloud.state?.bindings.find((binding) => binding.designId === opened.design.id);
    if (binding && browser.fileId !== binding.fileId)
      setBrowser((current) => ({ ...current, fileId: binding.fileId }));
  }, [opened?.design.id, canvasVisible, cloud.state?.bindings, browser.fileId, setBrowser]);
  const currentFolder = catalog?.folders.find((f) => f.id === folder);
  const files = (catalog?.files ?? []).filter(
    (f) =>
      (!currentFolder || f.folderId === currentFolder.id) &&
      f.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
  );
  const folderName = (file: CloudFile) =>
    catalog?.folders.find((f) => f.id === file.folderId)?.name ?? "Unfiled";
  const fileStatus = (file: CloudFile) => {
    const binding = cloud.state?.bindings.find((b) => b.fileId === file.id);
    return binding?.status === "conflict"
      ? "Conflicting edits"
      : binding?.status === "paused"
        ? "Sync paused"
        : binding?.status === "offline"
          ? "Saved locally"
          : binding
            ? "Available offline"
            : "In cloud";
  };
  const preview = (file: CloudFile) => {
    const binding = cloud.state?.bindings.find((b) => b.fileId === file.id);
    return binding ? (
      <LocalPreview
        api={api}
        projectId={binding.projectId}
        file={
          localFiles[binding.designId] ?? {
            id: binding.designId,
            name: file.name,
            path: "",
            updatedAt: file.updatedAt ?? "",
          }
        }
        enabled={active && !canvasVisible && !opening}
      />
    ) : (
      <CloudPreview api={api.cloud!} file={file} />
    );
  };
  return (
    <>
      {navigationTarget &&
        createPortal(
          <>
            <Button
              className={`sidebar-item design-files-home ${!currentFolder ? "selected" : ""}`}
              onClick={() => {
                setFolder(null);
                setQuery("");
              }}
              aria-current={!currentFolder ? "page" : undefined}
            >
              <Icon name="folder" size={15} />
              All files<span className="cloud-count">{catalog?.files.length ?? ""}</span>
            </Button>
            {!!catalog?.folders.length && (
              <>
                <div className="sidebar-heading design-folders-heading">Folders</div>
                <ul className="design-folder-list">
                  {catalog.folders.map((item) => (
                    <li key={item.id}>
                      <Button
                        className={`sidebar-item cloud-folder-link ${currentFolder?.id === item.id ? "selected" : ""}`}
                        onClick={() => {
                          setFolder(item.id);
                          setQuery("");
                        }}
                        aria-current={currentFolder?.id === item.id ? "page" : undefined}
                      >
                        <Icon name="folder" size={15} />
                        <span>{item.name}</span>
                        <span className="cloud-count">
                          {catalog.files.filter((f) => f.folderId === item.id).length}
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>,
          navigationTarget,
        )}
      {opened && (
        <div className="flex min-h-0 flex-1" hidden={!canvasVisible}>
          <LocalCanvas
            key={opened.design.id}
            api={api}
            projectId={opened.projectId}
            initial={opened.design}
            active={active && canvasVisible}
            onBack={() => {
              selection.current++;
              onCanvasChange(false);
              setCanvasVisible(false);
              setBrowser((current) => ({ ...current, fileId: null }));
              refresh.current();
            }}
            onUpdate={updateDesign}
            status={
              <SyncStatus
                api={api.cloud}
                state={cloud.state}
                projectId={opened.projectId}
                designId={opened.design.id}
                onKeepBoth={async () => {
                  const version = ++selection.current;
                  const value = await api.cloud!.keepBoth(
                    organizationId,
                    opened.projectId,
                    opened.design.id,
                  );
                  if (selection.current === version) {
                    setOpened(value);
                    setBrowser((current) => ({ ...current, fileId: null }));
                    refresh.current();
                  }
                }}
              />
            }
          />
        </div>
      )}
      <div className="project-files cloud-workspace" hidden={canvasVisible}>
        <div className={`design-browser-header ${filesHeader}`}>
          <h1 className="min-w-0 truncate text-3xl font-semibold tracking-tight">
            {currentFolder?.name ?? "All files"}
          </h1>
          <div className="file-browser-controls">
            <input
              className="cloud-search"
              aria-label="Search files"
              type="search"
              placeholder="Search files…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="new-file-control">
              <Button
                className="new-file-button"
                disabled={creating || !organization?.canEdit}
                onClick={() => void create()}
              >
                {creating ? "Creating…" : "+ New file"}
              </Button>
            </div>
            <FileViewToggle view={view} onChange={setView} />
          </div>
        </div>
        {offline && catalog && (
          <p className="cloud-notice" role="status">
            Offline · downloaded files are available. Changes sync when you reconnect.
          </p>
        )}
        {error && catalog && (
          <p className="cloud-notice" role="alert">
            {error}
          </p>
        )}
        {!catalog ? (
          <div className="cloud-unavailable">
            <p>{error || "Loading your files…"}</p>
            {error && (
              <Button className="quiet-button" onClick={() => refresh.current()}>
                Try again
              </Button>
            )}
          </div>
        ) : files.length ? (
          <ul className={view === "grid" ? filesGrid : "local-file-rows"}>
            {files.map((file) => (
              <li
                key={file.id}
                className={
                  view === "grid" ? "relative local-file-card" : "local-file-row cloud-file-row"
                }
              >
                {view === "grid" ? (
                  <FileCard
                    preview={preview(file)}
                    openLink={
                      <Button
                        className="file-open-overlay"
                        disabled={opening === file.id || !organization?.canEdit}
                        aria-label={`Open ${file.name}`}
                        aria-busy={opening === file.id}
                        onClick={() => void open(file)}
                      />
                    }
                  >
                    <span className="block truncate text-sm font-medium">{file.name}</span>
                    <div className="file-card-meta">
                      <span>{folderName(file)}</span>
                      <span>{opening === file.id ? "Opening…" : fileStatus(file)}</span>
                    </div>
                  </FileCard>
                ) : (
                  <>
                    <Button
                      className="cloud-row-open"
                      disabled={opening === file.id || !organization?.canEdit}
                      onClick={() => void open(file)}
                      aria-label={`Open ${file.name}`}
                      aria-busy={opening === file.id}
                    >
                      <span className="file-row-preview">{preview(file)}</span>
                      <span className="file-row-title">
                        {file.name}
                        <span className="file-row-location">{folderName(file)}</span>
                      </span>
                    </Button>
                    <span className="cloud-file-state">
                      {opening === file.id ? "Opening…" : fileStatus(file)}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="cloud-unavailable">
            <p>
              {query
                ? "No matching files"
                : currentFolder
                  ? "No files in this folder"
                  : "No files yet"}
            </p>
            {!query && !currentFolder && organization?.canEdit && (
              <p>Create a file to start designing. Your changes sync automatically.</p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
