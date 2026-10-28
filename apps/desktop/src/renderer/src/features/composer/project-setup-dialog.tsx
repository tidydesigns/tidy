import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Icon } from "@tidy/editor/components/ui/icon";
import { UserFacingError, isCancellation } from "@tidy/ui/errors";
import { showToast } from "@tidy/ui/toast";
import type { Bootstrap, DesktopAPI, ProjectSnapshot } from "../../../../shared/contracts/desktop";
import type { Directory } from "../../../../shared/contracts/browser-directory";
import {
  matchingCheckouts,
  repositoryURLSchema,
  type ProjectSetupIssue,
} from "../../../../shared/contracts/project-setup";
import type { ProjectSetupResult } from "../../../../shared/contracts/workspace-response";
import type { WorkspaceMachine } from "../../../../shared/remote";
import { codeMenuClassName } from "../../styles/code-ui";
import { errorText } from "../../app/workspace-error";
import {
  copyDraft,
  type Draft,
  type MachineSelection,
  type PreparedWorkspace,
} from "./machine-context";

type Catalog =
  | { kind: "loading" }
  | { kind: "ready"; bootstrap: Bootstrap; matches: string[] }
  | { kind: "error" };
function setupIssueText(issue: ProjectSetupIssue): string {
  if (issue.kind === "repository-mismatch")
    return "This folder uses a different repository. Choose another folder.";
  switch (issue.reason) {
    case "folder-unavailable":
      return "This folder is not available. Check its path and permissions, or choose another folder.";
    case "destination-unavailable":
      return "The destination folder already exists or cannot be created. Choose another parent folder, or open the existing folder.";
    case "project-folder-missing":
      return "The repository was cloned, but the project folder is missing. Check out the right branch on this machine, then open its folder.";
    case "invalid-repository":
      return "Enter an HTTPS or SSH repository URL with a valid repository name.";
    case "clone-failed":
      return "Could not clone the repository. Check Git access on this machine, then try again.";
    default: {
      const exhaustive: never = issue.reason;
      return exhaustive;
    }
  }
}
type Completion = {
  snapshot: ProjectSnapshot;
  bootstrap: Bootstrap;
  relation?: "matching" | "separate";
  signal: AbortSignal;
  draftChoice?: "keep" | "replace";
};
const inputClass =
  "h-10 w-full min-w-0 rounded-lg border border-border bg-panel px-3 text-[13px] text-ink outline-none placeholder:text-muted-ink focus:border-control-border focus:ring-2 focus:ring-control-border/20 disabled:opacity-50";

export function ProjectSetupDialog({
  machine,
  api,
  source,
  sourceAPI,
  preferredProjectId,
  destinationDrafts,
  pendingSetup,
  onSetup,
  onClose,
  onReady,
}: {
  machine: WorkspaceMachine;
  api: DesktopAPI;
  source: MachineSelection | null;
  sourceAPI: DesktopAPI;
  preferredProjectId?: string;
  destinationDrafts?: Record<string, Draft>;
  pendingSetup?: Promise<ProjectSetupResult>;
  onSetup(work: Promise<ProjectSetupResult>): void;
  onClose(): void;
  onReady(value: PreparedWorkspace): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [catalog, setCatalog] = useState<Catalog>({ kind: "loading" });
  const [draftConflict, setDraftConflict] = useState<Completion | null>(null);
  const [mode, setMode] = useState<"folder" | "clone">("folder");
  const [repository, setRepository] = useState("");
  const expectedRepository = useRef<string | null>(null);
  const repositoryPath = useRef("");
  const [path, setPath] = useState("");
  const [directory, setDirectory] = useState<Directory>();
  const [error, setError] = useState("");
  const [mismatch, setMismatch] = useState<{ path: string; repository: string | null } | null>(
    null,
  );
  const transfer = useRef(new AbortController());
  const [working, setWorking] = useState<"setup" | "copy" | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const directories = useRef(new Map<string, Promise<Directory>>());
  const home = useRef("");
  const live = useRef(true);
  const operation = useRef(false);
  const ready = machine.id === "local" || machine.status?.kind === "connected";
  useEffect(() => {
    live.current = true;
    dialog.current?.showModal();
    return () => {
      live.current = false;
      transfer.current.abort();
    };
  }, []);

  function loadDirectory(value: string) {
    const existing = directories.current.get(value);
    if (existing) return existing;
    if (!api.projectDirectories)
      return Promise.reject(new UserFacingError("Update this machine to browse folders."));
    const request = api.projectDirectories(value).catch((cause: unknown) => {
      directories.current.delete(value);
      throw cause;
    });
    directories.current.set(value, request);
    return request;
  }
  const browseVersion = useRef(0);
  async function browse(value: string) {
    const version = ++browseVersion.current;
    setBrowsing(true);
    setPath(value);
    setMismatch(null);
    setError("");
    try {
      const result = await loadDirectory(value);
      if (!live.current || browseVersion.current !== version) return;
      if (!value) home.current = result.path;
      setDirectory(result);
      setPath(result.path);
    } catch (cause) {
      if (live.current && browseVersion.current === version) {
        setDirectory(undefined);
        setError(
          cause instanceof UserFacingError
            ? cause.displayMessage
            : `Could not open this folder on ${machine.label}. Check the path and folder permissions.`,
        );
      }
    } finally {
      if (live.current && browseVersion.current === version) setBrowsing(false);
    }
  }

  async function finish({
    snapshot,
    bootstrap,
    relation = "matching",
    signal,
    draftChoice,
  }: Completion) {
    if (!live.current || signal.aborted) return;
    const existing = destinationDrafts?.[`${snapshot.project.id}:new`];
    if (
      source &&
      existing &&
      !draftChoice &&
      (existing.text.trim() || existing.designIds.length || existing.attachments?.length) &&
      JSON.stringify(existing) !== JSON.stringify(source.draft)
    ) {
      setDraftConflict({ snapshot, bootstrap, relation, signal });
      setWorking(null);
      operation.current = false;
      return;
    }
    setDraftConflict(null);
    setWorking("copy");
    const draft =
      draftChoice === "keep"
        ? existing
        : source
          ? await copyDraft({
              api: sourceAPI,
              source,
              target: api,
              projectId: snapshot.project.id,
              signal,
            })
          : undefined;
    signal.throwIfAborted();
    const activeProject = draft ? await api.selectProject(snapshot.project.id) : snapshot;
    if (live.current && !signal.aborted)
      onReady({
        bootstrap: {
          ...bootstrap,
          activeProject,
          projects: [
            activeProject.project,
            ...bootstrap.projects.filter((project) => project.id !== activeProject.project.id),
          ],
        },
        ...(draft ? { draft } : {}),
        relation: !expectedRepository.current ? "separate" : relation,
      });
  }

  useEffect(() => {
    if (!ready) return;
    let active = true;
    const controller = new AbortController();
    transfer.current = controller;
    const signal = controller.signal;
    setWorking(null);
    setDraftConflict(null);
    operation.current = false;
    setCatalog({ kind: "loading" });
    setError("");
    async function prepare() {
      if (!api.projectCheckouts || (source && !sourceAPI.projectCheckouts))
        throw new UserFacingError("Update Tidy on both machines to choose a project here.");
      const [bootstrap, candidates, origins] = await Promise.all([
        api.bootstrap(),
        api.projectCheckouts(),
        source ? sourceAPI.projectCheckouts?.(source.project.id) : Promise.resolve([]),
      ]);
      if (!active) return;
      const origin = origins?.find((item) => item.projectId === source?.project.id);
      expectedRepository.current = origin?.remotes[0] ?? null;
      repositoryPath.current = origin?.repositoryPath ?? "";
      setRepository(expectedRepository.current ?? "");
      const matches =
        source && origin
          ? matchingCheckouts({ source: origin, candidates }).map((item) => item.projectId)
          : [];
      const preferred = candidates.find(
        (candidate) =>
          candidate.projectId === preferredProjectId && matches.includes(candidate.projectId),
      );
      const automatic = preferred?.projectId ?? (matches.length === 1 ? matches[0] : undefined);
      setCatalog({ kind: "ready", bootstrap, matches });
      if (pendingSetup) {
        operation.current = true;
        setMode("clone");
        setWorking("setup");
        const result = await pendingSetup;
        if (!active) return;
        if (result.kind !== "ready") throw new UserFacingError(setupIssueText(result));
        await finish({ snapshot: result.snapshot, bootstrap, signal });
      } else if (automatic) {
        operation.current = true;
        setWorking("copy");
        let snapshot: ProjectSnapshot;
        try {
          snapshot = await api.selectProject(automatic);
        } catch {
          operation.current = false;
          setWorking(null);
          await browse("");
          if (active)
            setError("This project folder is no longer available. Choose another folder.");
          return;
        }
        await finish({ snapshot, bootstrap, signal });
      } else if (!source && bootstrap.activeProject) {
        await finish({ snapshot: bootstrap.activeProject, bootstrap, signal });
      } else {
        await browse("");
      }
    }
    void prepare().catch((cause: unknown) => {
      if (active && !isCancellation(cause)) {
        setError(errorText(cause));
        setCatalog({ kind: "error" });
        setWorking(null);
        operation.current = false;
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, sourceAPI, source, ready, attempt]);

  async function chooseProject(id: string) {
    if (catalog.kind !== "ready" || operation.current) return;
    const signal = transfer.current.signal;
    operation.current = true;
    setWorking("setup");
    setError("");
    try {
      await finish({ snapshot: await api.selectProject(id), bootstrap: catalog.bootstrap, signal });
    } catch (cause) {
      if (live.current && !isCancellation(cause)) setError(errorText(cause));
    } finally {
      if (transfer.current.signal === signal) {
        if (live.current) setWorking(null);
        operation.current = false;
      }
    }
  }

  async function setup(separateProject = false) {
    if (catalog.kind !== "ready" || operation.current || browsing || !ready) return;
    const signal = transfer.current.signal;
    operation.current = true;
    setWorking("setup");
    setError("");
    try {
      if (!path.startsWith("/"))
        throw new UserFacingError("Enter a full folder path or browse to a folder.");
      if (!api.setupProject)
        throw new UserFacingError("Update Tidy on this machine to open a project.");
      const work = api.setupProject(
        mode === "clone"
          ? {
              kind: "clone",
              repository: repositoryURLSchema.parse(repository),
              parent: path,
              repositoryPath: repositoryPath.current,
            }
          : {
              kind: "folder",
              path,
              repository: separateProject ? null : expectedRepository.current,
            },
      );
      if (!separateProject) onSetup(work);
      const result = await work;
      if (result.kind !== "ready") {
        if (result.kind === "repository-mismatch" && live.current) {
          setMismatch({ path, repository: result.repository });
          return;
        }
        throw new UserFacingError(setupIssueText(result));
      }
      if (!live.current) {
        showToast(`${result.snapshot.project.name} is ready on ${machine.label}.`, "success");
        return;
      }
      await finish({
        snapshot: result.snapshot,
        bootstrap: catalog.bootstrap,
        relation: separateProject ? "separate" : "matching",
        signal,
      });
    } catch (cause) {
      if (isCancellation(cause)) return;
      if (live.current) setError(errorText(cause));
      else showToast(`Project setup on ${machine.label} failed. ${errorText(cause)}`, "error");
    } finally {
      if (transfer.current.signal === signal) {
        if (live.current) setWorking(null);
        operation.current = false;
      }
    }
  }

  async function chooseDraft(draftChoice: "keep" | "replace") {
    if (!draftConflict || operation.current) return;
    operation.current = true;
    const signal = draftConflict.signal;
    try {
      await finish({ ...draftConflict, draftChoice });
    } catch (cause) {
      if (live.current && !isCancellation(cause)) setError(errorText(cause));
    } finally {
      if (transfer.current.signal === signal) {
        if (live.current) setWorking(null);
        operation.current = false;
      }
    }
  }

  const projects =
    catalog.kind === "ready"
      ? catalog.bootstrap.projects.filter(
          (project) => !source || catalog.matches.includes(project.id),
        )
      : [];
  function close() {
    if (working === "setup" && mode === "clone")
      showToast(`Cloning continues on ${machine.label}.`, "info");
    onClose();
  }
  const displayedPath =
    home.current && (path === home.current || path.startsWith(`${home.current}/`))
      ? `~${path.slice(home.current.length)}`
      : path;
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="m-auto w-[min(480px,calc(100vw-32px))] max-h-[calc(100dvh-48px)] overflow-y-auto rounded-2xl border border-border bg-(--desktop-surface) p-0 text-ink shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-[3px] [font-family:system-ui,sans-serif]"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="flex items-start justify-between gap-4 px-6 pt-6">
        <div className="min-w-0">
          <p className="mb-2 flex items-center gap-2 text-xs text-muted-ink">
            <Icon name="computer" size={14} />
            <span className="truncate">{machine.label}</span>
          </p>
          <h2
            id={titleId}
            className="m-0 text-base font-medium tracking-[-0.02em] [overflow-wrap:anywhere]"
          >
            {source ? `Set up ${source.project.name}` : "Choose a project"}
          </h2>
          <p id={descriptionId} className="mt-1.5 mb-0 text-[13px] leading-5 text-muted-ink">
            {working === "copy"
              ? "Copying your draft to this machine…"
              : source
                ? catalog.kind !== "ready"
                  ? "Checking this project's repository…"
                  : expectedRepository.current
                    ? "Choose this project's folder on this machine, or clone its repository."
                    : "Tidy could not identify this project's repository. Choose a folder to open as a separate project."
                : "Open a folder or clone a repository on this machine."}
          </p>
        </div>
        <Button
          className="quiet-button -mr-2 -mt-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-ink hover:bg-hover-surface"
          aria-label="Close project setup"
          onClick={close}
        >
          ×
        </Button>
      </div>
      <div className="px-6 pt-5 pb-6">
        {draftConflict && ready ? (
          <div className="text-[13px] leading-5">
            <p className="mt-0">
              There is already an unfinished draft in {draftConflict.snapshot.project.name} on{" "}
              {machine.label}.
            </p>
            <p className="text-muted-ink">
              Keep that draft, or replace it with the draft you are moving. Your original draft
              stays on the other machine.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                className="primary-button rounded-lg px-3 py-2"
                disabled={Boolean(working)}
                onClick={() => void chooseDraft("keep")}
              >
                Keep existing draft
              </Button>
              <Button
                className="quiet-button rounded-lg border border-border px-3 py-2"
                disabled={Boolean(working)}
                onClick={() => void chooseDraft("replace")}
              >
                Replace with this draft
              </Button>
            </div>
          </div>
        ) : !ready ? (
          <p className="m-0 text-[13px] leading-5 text-muted-ink" role="status">
            This machine is{" "}
            {machine.status?.kind === "reconnecting" ? "reconnecting" : "unavailable"}. Reconnect it
            in Settings under Remote machines.
          </p>
        ) : catalog.kind === "loading" ||
          working === "copy" ||
          (working === "setup" && pendingSetup) ? (
          <p role="status" className="m-0 text-[13px] text-muted-ink">
            {working === "copy"
              ? "Copying selected references and attachments…"
              : working === "setup"
                ? "Cloning repository…"
                : "Checking projects…"}
          </p>
        ) : (
          catalog.kind === "ready" && (
            <>
              {projects.length > 0 && (
                <div className="mb-4">
                  <SelectMenu
                    label="Project folder"
                    value=""
                    options={projects.map((project) => ({
                      value: project.id,
                      label: project.name,
                      description: project.path,
                    }))}
                    disabled={Boolean(working)}
                    onChange={(id) => void chooseProject(id)}
                    triggerContent={
                      <>
                        <Icon name="folder" size={15} />
                        <span>Use an existing project folder</span>
                      </>
                    }
                    triggerClassName={`${inputClass} flex cursor-pointer items-center gap-2 text-left`}
                    menuClassName={codeMenuClassName}
                  />
                </div>
              )}
              <div
                className="mb-4 flex gap-1 rounded-lg bg-subtle-fill p-1"
                role="group"
                aria-label="Project setup method"
              >
                {(
                  [
                    ["folder", "Existing folder"],
                    ["clone", "Clone repository"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    aria-pressed={mode === value}
                    disabled={Boolean(working)}
                    className={`min-h-8 flex-1 cursor-pointer rounded-md border-0 px-3 text-xs transition-colors hover:text-ink ${mode === value ? "bg-panel text-ink shadow-sm" : "bg-transparent text-muted-ink"}`}
                    onClick={() => {
                      setMode(value);
                      setMismatch(null);
                      setError("");
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void setup();
                }}
                className="flex flex-col gap-4"
              >
                {mode === "clone" && (
                  <label className="flex flex-col gap-2 text-xs text-muted-ink">
                    Repository
                    <input
                      className={inputClass}
                      aria-label="Repository URL"
                      value={repository}
                      readOnly={Boolean(expectedRepository.current)}
                      onChange={(event) => setRepository(event.currentTarget.value)}
                      placeholder="git@host:team/project.git"
                      disabled={Boolean(working)}
                      spellCheck={false}
                    />
                    {repositoryPath.current && (
                      <span>Opens {repositoryPath.current} inside the cloned repository.</span>
                    )}
                  </label>
                )}
                <label className="flex flex-col gap-2 text-xs text-muted-ink">
                  {mode === "clone" ? "Parent folder" : "Project folder"}
                  <div className="flex gap-2">
                    <input
                      className={inputClass}
                      aria-label={mode === "clone" ? "Parent folder" : "Project folder"}
                      value={displayedPath}
                      onChange={(event) => {
                        ++browseVersion.current;
                        setBrowsing(false);
                        setDirectory(undefined);
                        setMismatch(null);
                        setError("");
                        setPath(event.currentTarget.value.replace(/^~(?=\/|$)/, home.current));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void browse(path);
                        }
                      }}
                      disabled={Boolean(working)}
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      className="quiet-button shrink-0 rounded-lg border border-border px-3 text-xs"
                      disabled={Boolean(working) || !path}
                      onClick={() => void browse(path)}
                    >
                      Browse
                    </Button>
                  </div>
                </label>
                {directory && (
                  <div
                    className="max-h-40 overflow-y-auto rounded-lg border border-border bg-panel p-1"
                    aria-label="Project folders"
                    aria-busy={browsing}
                  >
                    {directory.parent && (
                      <Button
                        type="button"
                        className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-xs text-muted-ink hover:bg-hover-surface"
                        disabled={Boolean(working)}
                        onClick={() => void browse(directory.parent ?? "")}
                      >
                        <span aria-hidden="true">↰</span>Parent folder
                      </Button>
                    )}
                    {directory.directories.map((folder) => (
                      <Button
                        type="button"
                        key={folder.path}
                        className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-xs text-secondary-ink hover:bg-hover-surface"
                        disabled={Boolean(working)}
                        onPointerEnter={() => {
                          void loadDirectory(folder.path).catch(() => {});
                        }}
                        onClick={() => void browse(folder.path)}
                      >
                        <Icon name="folder" size={14} />
                        <span className="truncate">{folder.name}</span>
                        <span className="ml-auto text-muted-ink" aria-hidden="true">
                          ›
                        </span>
                      </Button>
                    ))}
                  </div>
                )}
                {mismatch?.path === path && source && (
                  <div
                    role="alert"
                    className="rounded-lg border border-border bg-panel p-3 text-[13px] leading-5"
                  >
                    <p className="m-0 font-medium">
                      {mismatch?.repository
                        ? `This folder uses a different repository than ${source.project.name}.`
                        : `Tidy could not match this folder to ${source.project.name}.`}
                    </p>
                    <p className="mt-1 mb-3 text-muted-ink [overflow-wrap:anywhere]">
                      {mismatch?.repository
                        ? `This folder uses ${mismatch.repository}.`
                        : "Tidy cannot verify that these folders use the same repository."}{" "}
                      Create a separate project on {machine.label} using this folder?
                    </p>
                    <Button
                      type="button"
                      className="quiet-button rounded-md border border-border px-3 py-1.5 text-xs"
                      disabled={Boolean(working)}
                      onClick={() => void setup(true)}
                    >
                      Create new project
                    </Button>
                  </div>
                )}
                <Button
                  type="submit"
                  className="primary-button mt-1 min-h-10 w-full rounded-lg text-[13px] active:scale-[0.99]"
                  disabled={
                    Boolean(working) ||
                    browsing ||
                    !path ||
                    mismatch?.path === path ||
                    (mode === "clone" && !repositoryURLSchema.safeParse(repository).success)
                  }
                >
                  {working
                    ? mode === "clone"
                      ? "Cloning repository…"
                      : "Opening project…"
                    : browsing
                      ? "Opening folder…"
                      : mode === "clone"
                        ? "Clone and continue"
                        : "Use this folder"}
                </Button>
              </form>
            </>
          )
        )}
        {error && (
          <p role="alert" className="mt-3 mb-0 text-xs leading-5 text-(--desktop-status-danger)">
            {error}
          </p>
        )}
        {catalog.kind === "error" && ready && (
          <Button
            className="quiet-button mt-3 text-xs"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </Button>
        )}
      </div>
    </dialog>
  );
}
