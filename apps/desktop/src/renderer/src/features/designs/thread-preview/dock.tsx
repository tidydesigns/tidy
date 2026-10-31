import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { SelectMenu } from "@tidy/ui/select-menu";
import { PreviewArtwork } from "../preview-renderers";
import type { CanvasViewportMemory } from "@tidy/editor";
import { DesignPreviewCache } from "./cache";
import { threadDesigns } from "./discovery";
import {
  discoverCanvases,
  parseCanvasDock,
  toggleCanvas,
  type CanvasGeometry,
  type ThreadCanvasDock,
} from "./dock-state";
import type {
  DesktopAPI,
  DesignSummary,
  LocalDesign,
  Thread,
} from "../../../../../shared/contracts/desktop";
import { ReloadAppButton } from "../../../components/lazy-view";
import { ThreadDesignWindow } from "./window";
import type { PreviewCameraMemory } from "./navigation";
import type { DockSlot } from "./window-geometry";

const viewports = new Map<
  string,
  Map<string, { editor: CanvasViewportMemory; preview: PreviewCameraMemory }>
>();

function CanvasGlyph() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M9 4v16M9 9h11" />
    </svg>
  );
}

function CanvasThumbnail({
  summary,
  value,
  load,
  onError,
}: {
  summary: DesignSummary;
  onError(error: unknown): void;
  value?: LocalDesign;
  load(summary: DesignSummary): Promise<LocalDesign>;
}) {
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!element.current || value?.updatedAt === summary.updatedAt) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void load(summary).catch(() => {});
      },
      { root: element.current.closest('[role="menu"]') },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [summary, value?.updatedAt, load]);
  return (
    <span ref={element} className="canvas-dock-thumbnail" aria-hidden="true" inert>
      {value ? (
        <PreviewArtwork
          onError={onError}
          content={value.document}
          assetUrl={(id) => value.assets[id] ?? ""}
        />
      ) : (
        <CanvasGlyph />
      )}
    </span>
  );
}

export function ThreadDesignDock({
  api,
  thread,
  designs,
  active,
  home,
  onUpdate,
}: {
  api: DesktopAPI;
  thread: Thread;
  designs: DesignSummary[];
  active: boolean;
  home: RefObject<HTMLSpanElement | null>;
  onUpdate(design: LocalDesign): void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewError = useCallback(() => setPreviewFailed(true), []);
  const key = `tidy:canvas-dock:${thread.projectId}:${thread.id}`;
  const [memories] = useState(() => {
    const memory =
      viewports.get(key) ??
      new Map<string, { editor: CanvasViewportMemory; preview: PreviewCameraMemory }>();
    viewports.delete(key);
    viewports.set(key, memory);
    const oldest = viewports.keys().next().value;
    if (viewports.size > 40 && oldest !== undefined) viewports.delete(oldest);
    return memory;
  });
  const [state, setState] = useState<ThreadCanvasDock>(() => {
    let saved: ThreadCanvasDock;
    try {
      saved = parseCanvasDock(localStorage.getItem(key));
    } catch {
      saved = parseCanvasDock(null);
    }
    return thread.status === "running"
      ? discoverCanvases(
          saved,
          threadDesigns(thread, designs).map((design) => design.id),
        )
      : saved;
  });
  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  }, [state]);
  const [focusedId, setFocusedId] = useState(state.openIds.at(-1));
  const [outgoingIds, setOutgoingIds] = useState<string[]>([]);
  const layer = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLSpanElement | null>(null);
  const [slot, setSlot] = useState<DockSlot | null>(null);
  const cache = useMemo(
    () => new DesignPreviewCache((id) => api.readDesign(thread.projectId, id)),
    [api, thread.projectId],
  );
  const previews = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  const readPreview = cache.load;
  const summaries = useMemo(
    () =>
      state.ids.flatMap((id) => {
        const summary = designs.find((design) => design.id === id);
        return summary ? [summary] : [];
      }),
    [state.ids, designs],
  );
  let lastUser: Thread["messages"][number] | undefined;
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    if (thread.messages[index].role === "user") {
      lastUser = thread.messages[index];
      break;
    }
  }
  const { toolActivities } = thread;
  const designIdKey = thread.designIds.join(":");
  const [pathCache] = useState(
    () => new WeakMap<NonNullable<Thread["toolActivities"]>[number], string[]>(),
  );
  const candidates = useMemo(
    () =>
      threadDesigns(
        {
          messages: lastUser ? [lastUser] : [],
          toolActivities,
          designIds: designIdKey ? designIdKey.split(":") : [],
        },
        designs,
        pathCache,
      ).map((design) => design.id),
    [lastUser, toolActivities, designIdKey, designs, pathCache],
  );
  useEffect(() => {
    if (thread.status === "running") setState((previous) => discoverCanvases(previous, candidates));
  }, [thread.status, candidates]);
  const revealed = useRef<string | undefined>(undefined);
  const reveal = thread.designPreview;
  useEffect(() => {
    if (!reveal || revealed.current === reveal.id || !designs.some((d) => d.id === reveal.designId))
      return;
    revealed.current = reveal.id;
    setState((previous) => {
      const next = discoverCanvases(previous, [reveal.designId]);
      return next.openIds.at(-1) === reveal.designId
        ? next
        : {
            ...next,
            openIds: [...next.openIds.filter((id) => id !== reveal.designId), reveal.designId],
          };
    });
    setFocusedId(reveal.designId);
  }, [reveal, designs]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {}
  }, [key, state]);
  useEffect(() => {
    const target = home.current;
    if (!active || !target) return;
    let idle: number | undefined;
    const preload = () => {
      if (idle !== undefined) return;
      idle = window.requestIdleCallback(
        () => {
          void Promise.allSettled(summaries.slice(0, 6).map(readPreview));
        },
        { timeout: 600 },
      );
    };
    target.addEventListener("pointerenter", preload);
    target.addEventListener("focusin", preload);
    return () => {
      target.removeEventListener("pointerenter", preload);
      target.removeEventListener("focusin", preload);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, [active, home, host, summaries, readPreview]);
  const update = useCallback(
    (value: LocalDesign) => {
      cache.update(value);
      onUpdate(value);
    },
    [cache, onUpdate],
  );

  useLayoutEffect(() => {
    setHost(home.current);
  }, [home]);
  useLayoutEffect(() => {
    const area = layer.current;
    const target = home.current;
    if (!area || !target || !active || !summaries.length) return;
    const measure = () => {
      const anchor = target.getBoundingClientRect();
      if (!anchor.width || !anchor.height) return;
      const bounds = area.getBoundingClientRect();
      const next = {
        x: anchor.left - bounds.left + (anchor.width - 28) / 2,
        y: anchor.top - bounds.top + (anchor.height - 28 / 1.5) / 2,
        width: 28,
      };
      setSlot((previous) => (previous?.x === next.x && previous?.y === next.y ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    const form = target.closest("form");
    if (form) observer.observe(form);
    observer.observe(area);
    return () => {
      observer.disconnect();
      delete target.dataset.canvasDrop;
    };
  }, [home, host, active, summaries.length]);

  const toggle = useCallback((id: string) => {
    const previous = latest.current;
    if (previous.openIds.includes(id)) {
      setOutgoingIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
      setFocusedId(previous.openIds.filter((value) => value !== id).at(-1) ?? id);
    } else setFocusedId(id);
    setState((value) => toggleCanvas(value, id));
  }, []);
  const activate = useCallback((id: string) => {
    setFocusedId(id);
    setState((previous) =>
      !previous.openIds.includes(id) || previous.openIds.at(-1) === id
        ? previous
        : { ...previous, openIds: [...previous.openIds.filter((value) => value !== id), id] },
    );
  }, []);
  const rememberGeometry = useCallback((id: string, geometry: CanvasGeometry) => {
    setState((previous) => ({ ...previous, geometry: { ...previous.geometry, [id]: geometry } }));
  }, []);
  const settled = useCallback((id: string) => {
    setOutgoingIds((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : ids));
  }, []);
  const warmId = state.openIds.includes(focusedId ?? "") ? focusedId : state.openIds.at(-1);
  const windows = useMemo(
    () =>
      summaries.filter(
        (summary) =>
          state.openIds.includes(summary.id) ||
          outgoingIds.includes(summary.id) ||
          warmId === summary.id,
      ),
    [summaries, state.openIds, outgoingIds, warmId],
  );
  return (
    <>
      {host &&
        active &&
        summaries.length > 0 &&
        createPortal(
          <SelectMenu
            value=""
            label="Canvases"
            actionMenu
            closeOnSelect={false}
            placement="top"
            align="end"
            className="canvas-dock-menu"
            triggerClassName="quiet-button canvas-dock-trigger"
            triggerContent={
              <>
                <CanvasGlyph />
                {summaries.length > 1 && (
                  <span className="canvas-dock-count">{summaries.length}</span>
                )}
              </>
            }
            options={summaries.map((summary) => ({
              value: summary.id,
              label: summary.name,
              checked: state.openIds.includes(summary.id),
              ariaLabel: `${state.openIds.includes(summary.id) ? "Dock" : "Open"} ${summary.name}`,
              icon: (
                <CanvasThumbnail
                  summary={summary}
                  onError={previewError}
                  value={previews[summary.id]}
                  load={readPreview}
                />
              ),
            }))}
            onChange={toggle}
          />,
          host,
        )}
      <div ref={layer} className="thread-design-dock-layer" hidden={!active}>
        {previewFailed && (
          <div className="pointer-events-auto absolute top-4 left-4 z-50 rounded border border-border bg-panel p-4 shadow-lg">
            <p role="alert" className="mb-3 text-sm">
              Could not load design previews.
            </p>
            <ReloadAppButton />
          </div>
        )}
        {host &&
          slot &&
          windows.map((summary) => {
            let viewportMemory = memories.get(summary.id);
            if (!viewportMemory) {
              viewportMemory = { editor: {}, preview: {} };
              memories.set(summary.id, viewportMemory);
            }
            return (
              <ThreadDesignWindow
                key={summary.id}
                api={api}
                onPreviewError={previewError}
                projectId={thread.projectId}
                summary={summary}
                active={active}
                working={thread.status === "running"}
                floating={state.openIds.includes(summary.id)}
                warm={warmId === summary.id}
                slot={slot}
                placement={summaries.indexOf(summary)}
                stackOrder={state.openIds.indexOf(summary.id) + 2}
                initialGeometry={state.geometry[summary.id]}
                viewportMemory={viewportMemory.editor}
                previewMemory={viewportMemory.preview}
                dockTarget={home}
                readPreview={readPreview}
                onDock={toggle}
                onActivate={activate}
                onGeometry={rememberGeometry}
                onDocked={settled}
                onUpdate={update}
              />
            );
          })}
      </div>
    </>
  );
}
