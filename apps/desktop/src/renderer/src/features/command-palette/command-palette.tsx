import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { Icon } from "@tidy/editor/components/ui/icon";
import { Button } from "@tidy/ui/button";
import type { DesktopAPI, Project, ProjectSnapshot } from "../../../../shared/contracts/desktop";
import { settingsSections, type SettingsPage } from "../settings/settings";
import { searchScore } from "./search";

type Catalog = Map<string, { snapshot: ProjectSnapshot; loadedAt: number }>;

type Item = {
  id: string;
  title: string;
  description?: string;
  keywords?: string;
  group: string;
  icon: ComponentProps<typeof Icon>["name"];
  submenu?: boolean;
  run(): void;
};

export function CommandPalette(props: {
  api?: Pick<DesktopAPI, "projectSnapshot">;
  projects: Project[];
  project?: Project;
  snapshots: Record<string, ProjectSnapshot>;
  onProject(projectId: string, snapshot?: ProjectSnapshot): void;
  onThread(projectId: string, threadId: string | null, snapshot?: ProjectSnapshot): void;
  onAddProject(): void;
  onSettings(page: SettingsPage): void;
}) {
  const [open, setOpen] = useState(false);
  const projects = useMemo(
    () =>
      props.project && !props.projects.some((entry) => entry.id === props.project?.id)
        ? [props.project, ...props.projects]
        : props.projects,
    [props.project, props.projects],
  );
  const cache = useRef<Catalog>(new Map());
  useEffect(() => {
    cache.current.clear();
  }, [props.api]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.code !== "KeyK"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, []);
  return open ? (
    <Palette {...props} projects={projects} cache={cache.current} onClose={() => setOpen(false)} />
  ) : null;
}

function Palette({
  api,
  projects,
  project,
  snapshots,
  onProject,
  onThread,
  onAddProject,
  onSettings,
  onClose,
  cache,
}: ComponentProps<typeof CommandPalette> & { onClose(): void; cache: Catalog }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [query, setQuery] = useState("");
  const [parentQuery, setParentQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, ProjectSnapshot>>(() =>
    Object.fromEntries([...cache].map(([key, value]) => [key, value.snapshot])),
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const projectIds = useMemo(
    () => projects.filter((entry) => !entry.cloud).map((entry) => entry.id),
    [projects],
  );
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => element?.close();
  }, []);
  useEffect(() => {
    const readSnapshot = api?.projectSnapshot;
    if (!readSnapshot) return;
    let disposed = false;
    setLoading(true);
    setFailed(false);
    const pending = projectIds.filter(
      (projectId) => retry > 0 || Date.now() - (cache.get(projectId)?.loadedAt ?? 0) > 30_000,
    );
    const load = async () => {
      while (!disposed) {
        const projectId = pending.shift();
        if (!projectId) return;
        try {
          const snapshot = await readSnapshot(projectId);
          if (!disposed) {
            cache.set(projectId, { snapshot, loadedAt: Date.now() });
            setCatalog((current) => ({ ...current, [projectId]: snapshot }));
          }
        } catch {
          if (!disposed) setFailed(true);
        }
      }
    };
    void Promise.all([load(), load()]).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [api, projectIds, retry, cache]);

  function run(action: () => void) {
    dialog.current?.close();
    onClose();
    action();
  }
  function back() {
    setQuery(parentQuery ?? "");
    setParentQuery(null);
    setSelected(null);
    input.current?.focus();
  }
  const threadItems = useMemo(
    () =>
      projects
        .flatMap((entry) => {
          const cached = snapshots[entry.id]?.threads ?? [];
          const threads = new Map(
            (catalog[entry.id]?.threads ?? cached).map((thread) => [thread.id, thread]),
          );
          for (const thread of cached) {
            const previous = threads.get(thread.id);
            if (!previous || previous.revision <= thread.revision) threads.set(thread.id, thread);
          }
          return [...threads.values()]
            .filter((thread) => !thread.parentThreadId)
            .map((thread) => ({
              updatedAt: thread.updatedAt,
              id: `thread:${thread.id}`,
              title: thread.title.trim() || "New thread",
              description: entry.name,
              keywords: `${thread.preview ?? ""} ${entry.name}`,
              group: "Threads",
              icon: "comment" as const,
              projectId: entry.id,
              threadId: thread.id,
            }));
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects, snapshots, catalog],
  );
  const items: Item[] =
    parentQuery !== null
      ? projects.map((entry) => ({
          id: `new:${entry.id}`,
          title: entry.name,
          description: entry.path,
          group: "New thread in…",
          icon: "folder",
          run: () => run(() => onThread(entry.id, null, catalog[entry.id])),
        }))
      : [
          ...(project
            ? [
                {
                  id: "new",
                  title: `New thread in ${project.name}`,
                  group: "Actions",
                  icon: "comment" as const,
                  run: () => run(() => onThread(project.id, null)),
                },
              ]
            : []),
          {
            id: "new-in",
            title: "New thread in…",
            group: "Actions",
            icon: "comment",
            submenu: true,
            run: () => {
              setParentQuery(query);
              setQuery("");
              setSelected(null);
            },
          },
          {
            id: "add",
            title: "Add project",
            keywords: "open folder new project",
            group: "Actions",
            icon: "folder",
            run: () => run(onAddProject),
          },
          {
            id: "settings",
            title: "Settings",
            keywords: "preferences",
            group: "Actions",
            icon: "settings",
            run: () => run(() => onSettings("account")),
          },
          ...Object.entries(settingsSections)
            .filter(([key]) => key !== "remote" || (window.tidyMachines && window.tidyRemote))
            .map(([page, title]) => ({
              id: `settings:${page}`,
              title: `${title} settings`,
              group: "Settings",
              icon: "settings" as const,
              run: () => {
                const entry = Object.keys(settingsSections).find(
                  (key): key is SettingsPage => key === page,
                );
                if (entry) run(() => onSettings(entry));
              },
            })),
          ...projects.map((entry) => ({
            id: `project:${entry.id}`,
            title: entry.name,
            description: entry.path,
            group: "Projects",
            icon: "folder" as const,
            run: () => run(() => onProject(entry.id, catalog[entry.id])),
          })),
          ...threadItems.map((item) => ({
            ...item,
            run: () => run(() => onThread(item.projectId, item.threadId, catalog[item.projectId])),
          })),
        ];
  const groups = ["Actions", "Settings", "Projects", "Threads", "New thread in…"].flatMap(
    (group) => {
      if (!query.trim() && group === "Settings") return [];
      const matches = items
        .filter((item) => item.group === group)
        .map((item) => ({
          item,
          score: searchScore(item.title, `${item.description ?? ""} ${item.keywords ?? ""}`, query),
        }))
        .filter(({ score }) => score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, !query.trim() && group === "Threads" ? 8 : 50)
        .map(({ item }) => item);
      return matches.length ? [{ label: group, items: matches }] : [];
    },
  );
  const visible = groups.flatMap((group) => group.items);
  const active = visible.find((item) => item.id === selected) ?? visible[0];
  const activeIndex = visible.findIndex((item) => item === active);
  useLayoutEffect(() => {
    document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [id, activeIndex, query]);
  return (
    <Dialog
      ref={dialog}
      padded={false}
      aria-label="Command palette"
      onClose={() => {
        if (!dialog.current?.open) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (parentQuery !== null) back();
        else onClose();
      }}
      className="[&]:top-[min(14vh,120px)] [&]:bottom-auto [&]:max-w-[620px] [&]:overflow-hidden [&]:rounded-xl"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Tab") {
          const targets = [
            ...event.currentTarget.querySelectorAll<HTMLElement>("input, button:not([disabled])"),
          ];
          const edge = event.shiftKey ? targets[0] : targets.at(-1);
          if (document.activeElement === edge) {
            event.preventDefault();
            (event.shiftKey ? targets.at(-1) : targets[0])?.focus();
          }
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next =
            visible[
              (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length
            ];
          if (next) setSelected(next.id);
        } else if (event.key === "Enter" && event.target === input.current) {
          event.preventDefault();
          active?.run();
        } else if (event.key === "Backspace" && !query && parentQuery !== null) {
          event.preventDefault();
          back();
        }
      }}
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-4">
        {parentQuery !== null ? (
          <Button
            aria-label="Back"
            onClick={back}
            className="rounded p-1 text-muted-ink hover:bg-hover-surface"
          >
            <Icon name="back" size={18} />
          </Button>
        ) : (
          <svg
            aria-hidden="true"
            className="shrink-0 text-muted-ink"
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
        )}
        <input
          ref={input}
          role="combobox"
          aria-label="Search commands, projects, and threads"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-activedescendant={active ? `${id}-${activeIndex}` : undefined}
          className="min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none placeholder:text-muted-ink focus-visible:outline-none"
          placeholder={
            parentQuery !== null ? "Choose a project…" : "Search commands, projects, and threads…"
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(null);
          }}
        />
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="Results"
        className="max-h-[min(420px,55dvh)] overflow-y-auto overscroll-contain p-2"
      >
        {groups.map((group) => (
          <div key={group.label} role="group" aria-label={group.label}>
            <div className="px-2 pt-3 pb-1.5 text-xs font-medium text-muted-ink">
              {!query.trim() && group.label === "Threads" ? "Recent threads" : group.label}
            </div>
            {group.items.map((item) => (
              <div
                key={item.id}
                id={`${id}-${visible.indexOf(item)}`}
                role="option"
                aria-selected={active === item}
                onPointerMove={() => {
                  if (selected !== item.id) setSelected(item.id);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={item.run}
                className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-2.5 text-sm ${active === item ? "bg-hover-surface text-ink" : "text-secondary-ink"}`}
              >
                <Icon name={item.icon} size={18} className="text-muted-ink" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.description && (
                  <span className="max-w-[38%] truncate text-xs text-muted-ink">
                    {item.description}
                  </span>
                )}
                {item.submenu && <Icon name="arrowRight" size={14} className="text-muted-ink" />}
              </div>
            ))}
          </div>
        ))}
        {!visible.length && (
          <p className="px-2 py-8 text-center text-sm text-muted-ink">
            {loading ? "Searching threads…" : "No results found"}
          </p>
        )}
      </div>
      {failed && (
        <div
          role="status"
          className="flex items-center justify-between px-4 py-2 text-xs text-muted-ink"
        >
          Some projects could not be searched.
          <Button
            className="rounded px-2 py-1 hover:bg-hover-surface"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      <footer className="flex items-center gap-4 border-t border-border px-4 py-3 text-xs text-muted-ink">
        <span className="inline-flex items-center gap-1.5">
          <kbd className="rounded bg-hover-surface px-1.5 py-1">↑</kbd>{" "}
          <kbd className="rounded bg-hover-surface px-1.5 py-1">↓</kbd> Navigate
        </span>
        <span className="inline-flex items-center gap-1.5">
          <kbd className="rounded bg-hover-surface px-1.5 py-1">Enter</kbd> Select
        </span>
        <span className="inline-flex items-center gap-1.5">
          <kbd className="rounded bg-hover-surface px-1.5 py-1">Esc</kbd>{" "}
          {parentQuery !== null ? "Back" : "Close"}
        </span>
        {loading && visible.length > 0 && (
          <span role="status" className="ml-auto">
            Searching threads…
          </span>
        )}
      </footer>
    </Dialog>
  );
}
