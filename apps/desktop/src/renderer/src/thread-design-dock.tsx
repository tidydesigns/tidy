import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { CanvasViewportMemory } from "@tidy/editor";
import { threadDesigns } from "../../shared/thread-design";
import {
  discoverCanvases,
  parseCanvasDock,
  type CanvasGeometry,
  type ThreadCanvasDock,
} from "../../shared/thread-canvas-dock";
import type { DesktopAPI, DesignSummary, LocalDesign, Thread } from "../../shared/contracts";
import { ThreadDesignWindow } from "./thread-design-window";

export type DockSlot = { x: number; y: number; width: number };
const viewports = new Map<string, Map<string, CanvasViewportMemory>>();

export function ThreadDesignDock({
  api,
  thread,
  designs,
  active,
  composer,
  onUpdate,
}: {
  api: DesktopAPI;
  thread: Thread;
  designs: DesignSummary[];
  active: boolean;
  composer: RefObject<HTMLFormElement | null>;
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
  const [lastId, setLastId] = useState(state.floatingId);
  const [outgoingIds, setOutgoingIds] = useState<string[]>([]);
  const selection = useRef(state.floatingId);
  selection.current = state.floatingId;
  const layer = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ x: 0, y: 0, width: 0 });
  const summaries = useMemo(
    () =>
      state.ids.flatMap((id) => {
        const summary = designs.find((design) => design.id === id);
        return summary ? [summary] : [];
      }),
    [state.ids, designs],
  );
  const count = Math.min(3, Math.max(1, Math.floor((bounds.width - 68) / 100)));
  const visible = useMemo(() => summaries.slice(0, count), [summaries, count]);
  const overflow = useMemo(() => summaries.slice(count), [summaries, count]);
  const tileWidth = Math.min(
    128,
    Math.max(72, (bounds.width - 24 - (overflow.length ? 48 : 0)) / count - 8),
  );
  const candidates = useMemo(
    () => threadDesigns(thread, designs).map((design) => design.id),
    [thread, designs],
  );
  useEffect(() => {
    if (thread.status === "running") setState((previous) => discoverCanvases(previous, candidates));
  }, [thread.status, candidates]);
  useEffect(() => {
    if (state.floatingId) setLastId(state.floatingId);
  }, [state.floatingId]);
  useEffect(() => {
    // Storage is tiny and runs after paint, outside pointer/keyboard handlers.
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* A full store must not block the canvas. */
    }
  }, [key, state]);

  useLayoutEffect(() => {
    const area = layer.current;
    const form = composer.current;
    if (!area || !form) return;
    form.dataset.canvasDock = String(active && summaries.length > 0);
    if (!active)
      return () => {
        delete form.dataset.canvasDock;
      };
    function measure() {
      const anchor = form!.getBoundingClientRect();
      const parent = area!.getBoundingClientRect();
      const next = {
        x: anchor.left - parent.left,
        y: anchor.top - parent.top - 36,
        width: anchor.width,
      };
      setBounds((previous) =>
        previous.x === next.x && previous.y === next.y && previous.width === next.width
          ? previous
          : next,
      );
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(form);
    observer.observe(area);
    return () => {
      observer.disconnect();
      delete form.dataset.canvasDock;
      delete form.dataset.canvasDrop;
    };
  }, [composer, active, summaries.length]);

  const open = useCallback((id: string) => {
    const previous = selection.current;
    if (previous && previous !== id)
      setOutgoingIds((ids) => (ids.includes(previous) ? ids : [...ids, previous]));
    setLastId(id);
    setState((previous) => ({ ...previous, floatingId: id }));
  }, []);
  const dock = useCallback(() => {
    setState((previous) => ({ ...previous, floatingId: undefined }));
  }, []);
  const rememberGeometry = useCallback((id: string, geometry: CanvasGeometry) => {
    setState((previous) => ({ ...previous, geometry: { ...previous.geometry, [id]: geometry } }));
  }, []);
  const settled = useCallback((id: string) => {
    setOutgoingIds((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : ids));
  }, []);
  const retained = summaries.find((design) => design.id === (state.floatingId ?? lastId));
  const windows = useMemo(() => {
    const result = [...visible];
    for (const summary of [
      retained,
      ...outgoingIds.map((id) => summaries.find((item) => item.id === id)),
    ])
      if (summary && !result.includes(summary)) result.push(summary);
    return result;
  }, [retained, visible, outgoingIds, summaries]);
  const slots = useMemo(
    () =>
      new Map(
        windows.map((summary) => {
          const index = visible.indexOf(summary);
          return [
            summary.id,
            {
              x: bounds.x + 16 + (index === -1 ? visible.length : index) * (tileWidth + 8),
              y: bounds.y,
              width: index === -1 ? 40 : tileWidth,
            },
          ];
        }),
      ),
    [windows, visible, bounds, tileWidth],
  );
  return (
    <div ref={layer} className="thread-design-dock-layer" hidden={!active}>
      {bounds.width > 0 &&
        windows.map((summary) => {
          let viewportMemory = memories.get(summary.id);
          if (!viewportMemory) {
            viewportMemory = {};
            memories.set(summary.id, viewportMemory);
          }
          const index = visible.indexOf(summary);
          const extra = index === -1;
          return (
            <ThreadDesignWindow
              key={summary.id}
              api={api}
              projectId={thread.projectId}
              summary={summary}
              active={active}
              working={thread.status === "running"}
              floating={state.floatingId === summary.id}
              warm={(state.floatingId ?? lastId) === summary.id}
              slot={slots.get(summary.id)!}
              overflow={extra}
              initialGeometry={state.geometry[summary.id]}
              viewportMemory={viewportMemory}
              composer={composer}
              onDock={dock}
              onUndock={open}
              onGeometry={rememberGeometry}
              onDocked={settled}
              onUpdate={onUpdate}
            />
          );
        })}
      {overflow.length > 0 && (
        <div
          className="thread-design-overflow"
          style={{ left: bounds.x + 16 + visible.length * (tileWidth + 8), top: bounds.y }}
        >
          <SelectMenu
            value=""
            label="More canvases"
            actionMenu
            placement="top"
            align="start"
            triggerClassName="thread-design-overflow-trigger"
            triggerContent={`+${overflow.length}`}
            options={overflow.map((design) => ({ value: design.id, label: design.name }))}
            onChange={open}
          />
        </div>
      )}
    </div>
  );
}
