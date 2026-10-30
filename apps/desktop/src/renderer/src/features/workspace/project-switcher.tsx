import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { Project } from "../../../../shared/contracts/desktop";
import type { CloudAccount } from "../../../../shared/contracts/cloud-sync";
import type { WorkspaceMachine } from "../../../../shared/remote";
import { ComposerChevron } from "../composer/composer-icon";
import { errorText } from "../../app/workspace-error";
import "./project-switcher.css";

type Catalog = { kind: "loading" } | { kind: "ready"; projects: Project[] } | { kind: "error" };
type Selection =
  | { kind: "idle" }
  | { kind: "opening"; machineId: string; projectId?: string }
  | { kind: "error"; machineId: string; text: string };
const focusClassName =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-control-border";
const rowClassName = `machine-project-row my-px flex min-h-8 w-full cursor-pointer items-center gap-[9px] rounded-[5px] border border-transparent bg-transparent px-[9px] py-1.5 text-left text-ink aria-[current=page]:border-ink/5 aria-[current=page]:bg-ink/6 enabled:hover:border-border enabled:hover:bg-hover-surface disabled:cursor-default disabled:opacity-50 [&>svg]:shrink-0 [&>svg]:text-muted-ink [&>[aria-hidden]]:text-muted-ink ${focusClassName}`;
const actionClassName = `machine-project-add flex min-h-8 w-full cursor-pointer items-center gap-[9px] rounded-[7px] border-0 bg-transparent px-[9px] py-1.5 text-left text-xs text-muted-ink hover:bg-hover-surface hover:text-ink ${focusClassName}`;
const headingClassName = `machine-project-heading flex min-h-[34px] cursor-pointer list-none items-center gap-[9px] px-2 py-1.5 select-none [&::-webkit-details-marker]:hidden ${focusClassName}`;
const deviceClassName = "grid size-4 shrink-0 place-items-center text-muted-ink";
const textClassName = "min-w-0 flex-1 truncate text-[13px]";
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
  const [expanded, setExpanded] = useState<Partial<Record<string, boolean>>>({
    [machineId]: true,
  });
  const [cloudExpanded, setCloudExpanded] = useState(Boolean(cloudId));
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
      triggerClassName="project-trigger flex min-h-[34px] min-w-0 max-w-full items-center gap-[7px] rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-[13px] text-ink hover:bg-hover-surface [&>svg]:shrink-0 [&>svg]:text-muted-ink"
      menuClassName="machine-project-dropdown w-[296px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-[10px] border border-ink/12 bg-(--desktop-surface) p-1.5 [font-family:system-ui,sans-serif]"
      maxMenuHeight={420}
      onOpenChange={(open) => {
        setSelection({ kind: "idle" });
        if (open) {
          committed.current = false;
          setVisit((value) => value + 1);
        } else {
          if (!committed.current) onCancelNavigation?.();
          request.current++;
        }
      }}
      triggerContent={
        <>
          <span className="truncate" data-ph-private>
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
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const rows = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>("summary, button:not(:disabled)"),
            ).filter((row) => !row.closest("details:not([open])") || row.tagName === "SUMMARY");
            if (!rows.length) return;
            event.preventDefault();
            const index = rows.findIndex((row) => row === document.activeElement);
            const next =
              event.key === "ArrowDown" ? index + 1 : index < 0 ? rows.length - 1 : index - 1;
            rows[(next + rows.length) % rows.length]?.focus();
          }}
        >
          <div className="max-h-[min(360px,calc(100dvh-120px))] overflow-y-auto overscroll-contain [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin]">
            {machines.map((machine) => {
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
                (project) => !removed.has(`${machine.id}:${project.id}`),
              );
              const status =
                machine.id === "local"
                  ? "This device"
                  : connected
                    ? "Connected"
                    : machine.status?.kind === "reconnecting" ||
                        machine.status?.kind === "preparing"
                      ? "Connecting…"
                      : "Offline";
              return (
                <details
                  key={machine.id}
                  className="machine-project-group group [&+&]:mt-1 [&+&]:border-t [&+&]:border-border [&+&]:pt-1"
                  open={expanded[machine.id] ?? false}
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
                    setExpanded((current) =>
                      current[machine.id] === open ? current : { ...current, [machine.id]: open },
                    );
                  }}
                >
                  <summary className={headingClassName}>
                    <span className={deviceClassName}>
                      <Icon name="computer" size={16} />
                    </span>
                    <span className="text-[13px] font-medium tracking-[-0.015em]">
                      {machine.label}
                    </span>
                    <span
                      className="ml-auto text-[11px] whitespace-nowrap text-muted-ink"
                      title={status}
                    >
                      {connected ? <span className="sr-only">{status}</span> : status}
                    </span>
                    <span className="mx-[5px] shrink-0 -rotate-90 text-muted-ink group-open:rotate-0">
                      <ComposerChevron />
                    </span>
                  </summary>
                  <div className="max-h-[min(260px,35dvh)] overflow-y-auto pl-3 [scrollbar-width:thin]">
                    {catalog.kind === "ready" &&
                      machineProjects.map((project) => (
                        <div key={project.id} className="group/project relative flex items-center">
                          <Button
                            className={`${rowClassName} ${onRemove ? "pr-9" : ""}`}
                            title={project.path}
                            disabled={!connected}
                            data-select-initial={
                              !cloudId && machine.id === machineId && project.id === projectId
                                ? ""
                                : undefined
                            }
                            aria-current={
                              !cloudId && machine.id === machineId && project.id === projectId
                                ? "page"
                                : undefined
                            }
                            onClick={() =>
                              void choose({
                                machineId: machine.id,
                                projectId: project.id,
                                close,
                              })
                            }
                          >
                            <Icon name="folder" size={17} />
                            <span className={textClassName}>{project.name}</span>
                            {selection.kind === "opening" &&
                            selection.machineId === machine.id &&
                            selection.projectId === project.id ? (
                              <span className="text-[11px] text-muted-ink" role="status">
                                Opening…
                              </span>
                            ) : !cloudId && machine.id === machineId && project.id === projectId ? (
                              <Icon name="check" size={16} />
                            ) : null}
                          </Button>
                          {onRemove && connected && (
                            <Button
                              aria-label={`Remove ${project.name} from ${machine.label}`}
                              title="Remove from this machine. Files stay on disk."
                              className={`absolute right-1 grid size-7 cursor-pointer place-items-center rounded border-0 bg-transparent text-muted-ink opacity-0 group-hover/project:opacity-100 hover:bg-hover-surface hover:text-ink focus-visible:opacity-100 ${focusClassName}`}
                              onClick={(event) => {
                                const key = `${machine.id}:${project.id}`;
                                if (removing.current.has(key)) return;
                                event.currentTarget
                                  .closest("details")
                                  ?.querySelector<HTMLElement>("summary")
                                  ?.focus({ preventScroll: true });
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
                        Loading projects…
                      </p>
                    )}
                    {connected && catalog.kind === "error" && (
                      <div className={messageClassName}>
                        Could not load projects.{" "}
                        <Button
                          className="machine-project-retry cursor-pointer border-0 bg-transparent p-1 text-xs text-ink"
                          onClick={() => void loadCatalog({ id: machine.id, refresh: true })}
                        >
                          Retry
                        </Button>
                      </div>
                    )}
                    {connected ? (
                      <Button
                        className={actionClassName}
                        onClick={() => void choose({ machineId: machine.id, close })}
                      >
                        <span className="w-4 text-center text-[19px] leading-4" aria-hidden="true">
                          ＋
                        </span>
                        {selection.kind === "opening" &&
                        selection.machineId === machine.id &&
                        !selection.projectId
                          ? "Opening…"
                          : "Open project…"}
                      </Button>
                    ) : (
                      <div className={messageClassName}>
                        {status === "Connecting…"
                          ? "Waiting for this machine to reconnect."
                          : "Reconnect this machine in Settings."}
                      </div>
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
                </details>
              );
            })}
            {cloudWorkspaces.length > 0 && (
              <details
                className="group mt-1 border-t border-border pt-1"
                open={cloudExpanded}
                onToggle={(event) => setCloudExpanded(event.currentTarget.open)}
              >
                <summary className={headingClassName}>
                  <span className={deviceClassName}>
                    <Icon name="cloud" size={16} />
                  </span>
                  <span className="text-[13px] font-medium tracking-[-0.015em]">
                    Cloud workspaces
                  </span>
                  <span className="ml-auto mr-[5px] shrink-0 -rotate-90 text-muted-ink group-open:rotate-0">
                    <ComposerChevron />
                  </span>
                </summary>
                <div className="max-h-[min(260px,35dvh)] overflow-y-auto pl-3 [scrollbar-width:thin]">
                  {cloudWorkspaces.map((workspace) => (
                    <Button
                      key={workspace.id}
                      className={rowClassName}
                      aria-current={cloudId === workspace.id ? "page" : undefined}
                      onClick={() => {
                        onCloudChange(workspace.id);
                        close();
                      }}
                    >
                      <Icon name="cloud" size={17} />
                      <span className={textClassName}>{workspace.name}</span>
                      {cloudId === workspace.id && <Icon name="check" size={16} />}
                    </Button>
                  ))}
                </div>
              </details>
            )}
          </div>
          {onAddMachine && (
            <div className="machine-project-footer mt-[5px] flex items-center border-t border-border pt-1 [&>button]:w-auto">
              <Button
                className={actionClassName}
                onClick={() => {
                  close();
                  onAddMachine();
                }}
              >
                <span className="w-4 text-center text-[19px] leading-4" aria-hidden="true">
                  ＋
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
