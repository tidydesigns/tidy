import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { SelectMenu } from "@tidy/ui/select-menu";
import { DocumentPreview } from "@tidy/editor/components/files/document-preview";
import type { CanvasViewportMemory } from "@tidy/editor";
import { threadDesigns } from "../../shared/thread-design";
import {
  discoverCanvases,
  parseCanvasDock,
  toggleCanvas,
  type CanvasGeometry,
  type ThreadCanvasDock,
} from "../../shared/thread-canvas-dock";
import type { DesktopAPI, DesignSummary, LocalDesign, Thread } from "../../shared/contracts";
import { ThreadDesignWindow } from "./thread-design-window";

export type DockSlot = { x: number; y: number; width: number };
const viewports = new Map<string, Map<string, CanvasViewportMemory>>();

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
}: {
  summary: DesignSummary;
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
        <DocumentPreview content={value.document} assetUrl={(id) => value.assets[id] ?? ""} />
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
  const key = `tidy:canvas-dock:${thread.projectId}:${thread.id}`;
  const [memories] = useState(() => {
    const memory = viewports.get(key) ?? new Map<string, CanvasViewportMemory>();
    viewports.delete(key);
    viewports.set(key, memory);
    if (viewports.size > 40) viewports.delete(viewports.keys().next().value!);
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
  latest.current = state;
  const [focusedId, setFocusedId] = useState(state.openIds.at(-1));
  const [outgoingIds, setOutgoingIds] = useState<string[]>([]);
  const layer = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLSpanElement | null>(null);
  const [slot, setSlot] = useState<DockSlot | null>(null);
  const cache = useRef(new Map<string, { stamp: string; value: LocalDesign }>());
  const pending = useRef(new Map<string, Promise<LocalDesign>>());
  const [previews, setPreviews] = useState<Record<string, LocalDesign>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const summaries = useMemo(
    () =>
      state.ids.flatMap((id) => {
        const summary = designs.find((design) => design.id === id);
        return summary ? [summary] : [];
      }),
    [state.ids, designs],
  );
  const candidates = useMemo(
    () => threadDesigns(thread, designs).map((design) => design.id),
    [thread, designs],
  );
  useEffect(() => {
    if (thread.status === "running") setState((previous) => discoverCanvases(previous, candidates));
  }, [thread.status, candidates]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* Keep controls usable when storage is unavailable. */
    }
  }, [key, state]);
  const readPreview = useCallback(
    (summary: DesignSummary): Promise<LocalDesign> => {
      const saved = cache.current.get(summary.id);
      if (saved?.stamp === summary.updatedAt) return Promise.resolve(saved.value);
      const requestKey = `${summary.id}:${summary.updatedAt}`;
      const existing = pending.current.get(requestKey);
      if (existing) return existing;
      const request = api
        .readDesign(thread.projectId, summary.id)
        .then((value) => {
          // An older read must not overwrite a newer edit or refresh.
          const current = cache.current.get(summary.id);
          if (!current || current === saved || current.value.updatedAt < value.updatedAt) {
            cache.current.set(summary.id, { stamp: summary.updatedAt, value });
            if (mounted.current) setPreviews((previous) => ({ ...previous, [value.id]: value }));
          }
          return cache.current.get(summary.id)?.value ?? value;
        })
        .finally(() => pending.current.delete(requestKey));
      pending.current.set(requestKey, request);
      return request;
    },
    [api, thread.projectId],
  );
  useEffect(() => {
    if (!active) return;
    // Preload the first visible rows in idle time; longer lists load only visible thumbnails.
    const idle = window.requestIdleCallback(
      () => {
        void Promise.allSettled(summaries.slice(0, 6).map(readPreview));
      },
      { timeout: 600 },
    );
    return () => window.cancelIdleCallback(idle);
  }, [active, summaries, readPreview]);
  const update = useCallback(
    (value: LocalDesign) => {
      cache.current.set(value.id, { stamp: value.updatedAt, value });
      setPreviews((previous) => ({ ...previous, [value.id]: value }));
      onUpdate(value);
    },
    [onUpdate],
  );

  useLayoutEffect(() => {
    setHost(home.current);
  }, [home]);
  useLayoutEffect(() => {
    const area = layer.current;
    const target = home.current;
    if (!area || !target || !active || !summaries.length) return;
    function measure() {
      const anchor = target!.getBoundingClientRect();
      if (!anchor.width || !anchor.height) return;
      const bounds = area!.getBoundingClientRect();
      const next = {
        x: anchor.left - bounds.left + (anchor.width - 28) / 2,
        y: anchor.top - bounds.top + (anchor.height - 28 / 1.5) / 2,
        width: 28,
      };
      setSlot((previous) => (previous?.x === next.x && previous?.y === next.y ? previous : next));
    }
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
  const warmId = state.openIds.includes(focusedId ?? "")
    ? focusedId
    : (state.openIds.at(-1) ?? focusedId);
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
        {host &&
          slot &&
          windows.map((summary) => {
            let viewportMemory = memories.get(summary.id);
            if (!viewportMemory) {
              viewportMemory = {};
              memories.set(summary.id, viewportMemory);
            }
            return (
              <ThreadDesignWindow
                key={summary.id}
                api={api}
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
                viewportMemory={viewportMemory}
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
