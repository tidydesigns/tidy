import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { Project } from "../../../../shared/contracts/desktop";
import type { CloudAccount } from "../../../../shared/contracts/cloud-sync";
import type { WorkspaceMachine } from "../../../../shared/remote";
import { ComposerChevron, ComposerIcon } from "../composer/composer-icon";
import { errorText } from "../../app/workspace-error";
import "../../styles/picker.css";
import "./project-switcher.css";

type Catalog = { kind: "loading" } | { kind: "ready"; projects: Project[] } | { kind: "error" };
type Selection =
  | { kind: "idle" }
  | { kind: "opening"; machineId: string; projectId?: string }
  | { kind: "error"; machineId: string; text: string };
const focusClassName =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-control-border";
const rowClassName = `machine-project-row my-px flex w-full cursor-pointer items-center text-left text-ink disabled:cursor-default disabled:opacity-50 [&>[aria-hidden]]:text-muted-ink ${focusClassName}`;
const actionClassName = `machine-project-add flex w-full cursor-pointer items-center border-0 bg-transparent text-left text-muted-ink hover:text-ink ${focusClassName}`;
const textClassName = "machine-project-text";
const messageClassName = "m-0 px-3 py-2 text-xs text-muted-ink";
const localMachines: WorkspaceMachine[] = [{ id: "local", label: "This machine", status: null }];

export function ProjectSwitcher({
  machines = localMachines,
  machineId = "local",
  projects,
  projectId,
  loadProjects,
  onChoose,
  onRemove,
  onCancelNavigation,
  onAddMachine,
  cloudWorkspaces,
  cloudId,
  onCloudChange,
  label,
  disabled,
}: {
  machines?: WorkspaceMachine[];
  machineId?: string;
  projects: Project[];
  projectId?: string;
  loadProjects?(id: string, refresh?: boolean): Promise<Project[]>;
  onChoose(machineId: string, projectId?: string): Promise<void>;
  onRemove?(machineId: string, projectId: string): Promise<void>;
  onCancelNavigation?(): void;
  onAddMachine?: () => void;
  cloudWorkspaces: Pick<CloudAccount["organizations"][number], "id" | "name">[];
  cloudId?: string;
  onCloudChange(id: string): void;
  label?: string;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [visit, setVisit] = useState(0);
  const [catalogs, setCatalogs] = useState<Partial<Record<string, Catalog>>>({});
  const [selection, setSelection] = useState<Selection>({ kind: "idle" });
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const removing = useRef(new Set<string>());
  const catalogVersions = useRef(new Map<string, number>());
  const request = useRef(0);
  const committed = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      request.current++;
    };
  }, []);
  const loadCatalog = useCallback(
    async ({
      id,
      refresh = false,
      isCurrent = () => live.current,
    }: {
      id: string;
      refresh?: boolean;
      isCurrent?(): boolean;
    }) => {
      if (!loadProjects) return;
      const version = (catalogVersions.current.get(id) ?? 0) + 1;
      catalogVersions.current.set(id, version);
      setCatalogs((catalogs) =>
        catalogs[id]?.kind === "ready"
          ? catalogs
          : {
              ...catalogs,
              [id]: { kind: "loading" },
            },
      );
      try {
        const projects = await loadProjects(id, refresh);
        if (isCurrent() && catalogVersions.current.get(id) === version)
          setCatalogs((catalogs) => ({
            ...catalogs,
            [id]: { kind: "ready", projects },
          }));
      } catch {
        if (isCurrent() && catalogVersions.current.get(id) === version)
          setCatalogs((catalogs) =>
            catalogs[id]?.kind === "ready"
              ? catalogs
              : {
                  ...catalogs,
                  [id]: { kind: "error" },
                },
          );
      }
    },
    [loadProjects],
  );
  useEffect(() => {
    let active = true;
    for (const machine of machines) {
      if (
        machine.id !== machineId &&
        (machine.id === "local" || machine.status?.kind === "connected")
      )
        void loadCatalog({ id: machine.id, isCurrent: () => active });
    }
    return () => {
      active = false;
    };
  }, [machines, machineId, loadCatalog, visit]);

  async function choose({
    machineId,
    projectId,
    close,
  }: {
    machineId: string;
    projectId?: string;
    close(): void;
  }) {
    const version = ++request.current;
    setSelection({ kind: "opening", machineId, projectId });
    try {
      await onChoose(machineId, projectId);
      if (live.current && request.current === version) {
        committed.current = true;
        close();
      }
    } catch (cause) {
      if (live.current && request.current === version)
        setSelection({ kind: "error", machineId, text: errorText(cause) });
    }
  }
  const activeProject = projects.find((project) => project.id === projectId);
  const search = query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(search);
  const entries = machines.map((machine) => {
    const connected = machine.id === "local" || machine.status?.kind === "connected";
    const catalog: Catalog =
      machine.id === machineId
        ? { kind: "ready", projects }
        : (catalogs[machine.id] ?? { kind: "loading" });
    const byPath = new Map<string, Project>();
    if (catalog.kind === "ready")
      for (const project of catalog.projects) {
        if (!byPath.has(project.path) || project.id === projectId)
          byPath.set(project.path, project);
      }
    const machineProjects = [...byPath.values()].filter(
      (project) =>
        !removed.has(`${machine.id}:${project.id}`) &&
        matches(`${project.name} ${machine.label} ${project.path}`),
    );
    const status =
      machine.status?.kind === "reconnecting" || machine.status?.kind === "preparing"
        ? "Connecting…"
        : "Offline";
    return {
      machine,
      connected,
      catalog,
      machineProjects,
      status,
      showOpen: connected && (!search || matches(machine.label) || matches("Open project")),
      showOffline: !connected && !machineProjects.length && matches(machine.label),
    };
  });
  const workspaces = cloudWorkspaces.filter((workspace) =>
    matches(`${workspace.name} Cloud workspace`),
  );
  const hasResults =
    workspaces.length ||
    entries.some(
      ({ machineProjects, showOpen, showOffline, connected, catalog }) =>
        machineProjects.length ||
        showOpen ||
        showOffline ||
        (connected && catalog.kind !== "ready"),
    );
  return (
    <SelectMenu
      value={projectId ?? ""}
      options={[]}
      onChange={() => {}}
      label="Switch project"
      actionMenu
      disabled={disabled && selection.kind !== "opening"}
      placement="bottom"
      align="start"
      triggerClassName="project-trigger"
      menuClassName="machine-project-dropdown desktop-picker"
      maxMenuHeight={420}
      onOpenChange={(open) => {
        setSelection({ kind: "idle" });
        if (open) {
          committed.current = false;
          setVisit((value) => value + 1);
        } else {
          setQuery("");
          if (!committed.current) onCancelNavigation?.();
          request.current++;
        }
      }}
      triggerContent={
        <>
          <span
            className="truncate"
            title={label ?? activeProject?.name ?? "Projects"}
            data-ph-private
          >
            {label ?? activeProject?.name ?? "Projects"}
          </span>
          <ComposerChevron />
        </>
      }
      menuContent={(close) => (
        <div
          className="machine-project-panel"
          data-ph-private
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.target === searchInput.current) {
              event.preventDefault();
              event.currentTarget
                .querySelector<HTMLButtonElement>(".machine-project-row:not(:disabled)")
                ?.click();
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const rows = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            ];
            if (!rows.length) return;
            event.preventDefault();
            const index = rows.findIndex((row) => row === document.activeElement);
            if (document.activeElement === searchInput.current) {
              rows[event.key === "ArrowDown" ? 0 : rows.length - 1]?.focus();
            } else if (event.key === "ArrowUp" && index === 0) {
              searchInput.current?.focus();
            } else {
              rows[
                (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length
              ]?.focus();
            }
          }}
        >
          <div className="picker-search">
            <ComposerIcon name="search" />
            <input
              data-select-search
              ref={searchInput}
              aria-label="Search projects and workspaces"
              placeholder="Search…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="machine-project-list">
            {!hasResults && search && (
              <p className={messageClassName} role="status">
                No matching projects
              </p>
            )}
            {entries.map(
              ({ machine, connected, catalog, machineProjects, status, showOffline }) => (
                <div key={machine.id}>
                  {machineProjects.map((project) => (
                    <div key={project.id} className="group/project relative flex items-center">
                      <Button
                        className={rowClassName}
                        title={project.path}
                        aria-label={`${project.name}, ${machine.label}`}
                        disabled={!connected}
                        aria-current={
                          !cloudId && machine.id === machineId && project.id === projectId
                            ? "page"
                            : undefined
                        }
                        onClick={() =>
                          void choose({ machineId: machine.id, projectId: project.id, close })
                        }
                      >
                        <Icon name="folder" size={14} />
                        <span className={textClassName}>
                          <span className="picker-label block truncate">{project.name}</span>
                          <span className="picker-description" title={machine.label}>
                            {machine.label}
                            {!connected ? ` · ${status}` : ""}
                          </span>
                        </span>
                        <span className="machine-project-indicator">
                          {selection.kind === "opening" &&
                          selection.machineId === machine.id &&
                          selection.projectId === project.id ? (
                            <span aria-label="Opening project" role="status">
                              …
                            </span>
                          ) : !cloudId && machine.id === machineId && project.id === projectId ? (
                            <Icon name="check" size={14} />
                          ) : null}
                        </span>
                      </Button>
                      {onRemove && connected && (
                        <Button
                          aria-label={`Remove ${project.name} from ${machine.label}`}
                          title="Remove from this machine. Files stay on disk."
                          className={`machine-project-remove absolute grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent text-muted-ink opacity-0 group-hover/project:opacity-100 hover:bg-hover-surface hover:text-ink focus-visible:opacity-100 ${focusClassName}`}
                          onClick={() => {
                            const key = `${machine.id}:${project.id}`;
                            if (removing.current.has(key)) return;
                            searchInput.current?.focus({ preventScroll: true });
                            request.current++;
                            onCancelNavigation?.();
                            setSelection({ kind: "idle" });
                            removing.current.add(key);
                            catalogVersions.current.set(
                              machine.id,
                              (catalogVersions.current.get(machine.id) ?? 0) + 1,
                            );
                            setRemoved((items) => new Set([...items, key]));
                            void onRemove(machine.id, project.id)
                              .then(() => {
                                if (!live.current) return;
                                catalogVersions.current.set(
                                  machine.id,
                                  (catalogVersions.current.get(machine.id) ?? 0) + 1,
                                );
                                setCatalogs((items) => {
                                  const catalog = items[machine.id];
                                  return catalog?.kind === "ready"
                                    ? {
                                        ...items,
                                        [machine.id]: {
                                          kind: "ready",
                                          projects: catalog.projects.filter(
                                            (item) => item.id !== project.id,
                                          ),
                                        },
                                      }
                                    : items;
                                });
                                setRemoved(
                                  (items) => new Set([...items].filter((item) => item !== key)),
                                );
                              })
                              .catch((error: unknown) => {
                                if (!live.current) return;
                                setRemoved(
                                  (items) => new Set([...items].filter((item) => item !== key)),
                                );
                                setSelection({
                                  kind: "error",
                                  machineId: machine.id,
                                  text: errorText(error),
                                });
                              })
                              .finally(() => removing.current.delete(key));
                          }}
                        >
                          <Icon name="xmark" size={12} />
                        </Button>
                      )}
                    </div>
                  ))}
                  {connected && catalog.kind === "loading" && (
                    <p className={messageClassName} role="status">
                      {machine.label} · Loading projects…
                    </p>
                  )}
                  {connected && catalog.kind === "error" && (
                    <div className={messageClassName}>
                      Could not load projects on {machine.label}.{" "}
                      <Button
                        className="machine-project-retry cursor-pointer border-0 bg-transparent p-1 text-xs text-ink"
                        onClick={() => void loadCatalog({ id: machine.id, refresh: true })}
                      >
                        Retry
                      </Button>
                    </div>
                  )}
                  {showOffline && (
                    <p className={messageClassName}>
                      {machine.label} · {status}
                    </p>
                  )}
                  {selection.kind === "error" && selection.machineId === machine.id && (
                    <p
                      className="m-0 px-3 py-2 text-xs text-(--desktop-status-danger)"
                      role="alert"
                    >
                      {selection.text}
                    </p>
                  )}
                </div>
              ),
            )}
            {workspaces.map((workspace) => (
              <Button
                key={workspace.id}
                className={rowClassName}
                aria-label={`${workspace.name} cloud workspace`}
                title={workspace.name}
                aria-current={cloudId === workspace.id ? "page" : undefined}
                onClick={() => {
                  committed.current = true;
                  onCloudChange(workspace.id);
                  close();
                }}
              >
                <Icon name="cloud" size={14} />
                <span className={textClassName}>
                  <span className="picker-label block truncate">{workspace.name}</span>
                  <span className="picker-description">Cloud</span>
                </span>
                <span className="machine-project-indicator">
                  {cloudId === workspace.id && <Icon name="check" size={14} />}
                </span>
              </Button>
            ))}
            {entries.some((entry) => entry.showOpen) && (
              <div className="machine-project-actions">
                {entries
                  .filter((entry) => entry.showOpen)
                  .map(({ machine }) => (
                    <Button
                      key={machine.id}
                      className={actionClassName}
                      aria-label={`Open project on ${machine.label}`}
                      onClick={() => void choose({ machineId: machine.id, close })}
                    >
                      <span className="machine-project-plus" aria-hidden="true">
                        +
                      </span>
                      <span className={textClassName}>
                        <span className="picker-label truncate">
                          {selection.kind === "opening" &&
                          selection.machineId === machine.id &&
                          !selection.projectId
                            ? "Opening…"
                            : "Open project…"}
                        </span>
                        <span className="picker-description" title={machine.label}>
                          {machine.label}
                        </span>
                      </span>
                      <span className="machine-project-indicator" aria-hidden="true" />
                    </Button>
                  ))}
              </div>
            )}
          </div>
          {onAddMachine && (
            <div className="machine-project-footer">
              <Button
                className={actionClassName}
                onClick={() => {
                  close();
                  onAddMachine();
                }}
              >
                <span className="machine-project-plus" aria-hidden="true">
                  +
                </span>
                Add machine
              </Button>
            </div>
          )}
        </div>
      )}
    />
  );
}
