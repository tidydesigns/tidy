"use client";
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { nodePageId, type DesignDocument } from "@/lib/design/document";
import {
  activityLabels,
  activityVisible,
  type AgentActivityStore,
  type AgentActivity,
} from "@/lib/realtime/agent-activity";
import { canvasElements } from "./canvas-elements";

type Marker = { x: number; y: number; activities: AgentActivity[] };
/** Native agents share the existing room transport but have one stable identity
 * each. Only genuine node targets produce cursors; reasoning has no fake motion. */
export function AgentCursors({
  store,
  document: content,
  pageId,
  view,
  viewport,
  onOpen,
}: {
  store: AgentActivityStore;
  document: DesignDocument;
  pageId: string;
  view: { x: number; y: number; zoom: number };
  viewport: React.RefObject<HTMLDivElement | null>;
  onOpen: (threadId: string) => void;
}) {
  const activities = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [now, setNow] = useState(0);
  const agents = useMemo(
    () => activities.filter((activity) => activity.threadId && activity.agentId),
    [activities],
  );
  useEffect(() => {
    if (!agents.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [agents]);
  useLayoutEffect(() => {
    const measure = () => {
      const canvas = viewport.current;
      if (!canvas) return;
      const origin = canvas.getBoundingClientRect(),
        elements = canvasElements(canvas);
      const nodes = new Map(content.nodes.map((node) => [node.id, node]));
      const grouped = new Map<string, Marker>();
      for (const activity of agents) {
        if (!activityVisible(activity)) continue;
        const target = activity.nodeIds?.map((id) => nodes.get(id)).find(Boolean);
        if (!target) continue;
        let root = target;
        const seen = new Set<string>();
        while (root.parentId && nodes.has(root.parentId) && !seen.has(root.id)) {
          seen.add(root.id);
          root = nodes.get(root.parentId)!;
        }
        if (nodePageId(root) !== pageId) continue;
        const element = elements.get(target.id);
        if (!element) continue;
        const box = element.getBoundingClientRect();
        if (
          box.right < origin.left ||
          box.left > origin.right ||
          box.bottom < origin.top ||
          box.top > origin.bottom
        )
          continue;
        const x = Math.max(8, Math.min(box.left - origin.left, origin.width - 36)),
          y = Math.max(8, Math.min(box.top - origin.top, origin.height - 36));
        const key = `${Math.round(x / 48)}:${Math.round(y / 32)}`;
        const group = grouped.get(key);
        if (group) group.activities.push(activity);
        else grouped.set(key, { x, y, activities: [activity] });
      }
      setMarkers([...grouped.values()]);
    };
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [agents, content.nodes, pageId, view, viewport, now]);
  if (!markers.length) return null;
  const cursor = (activity: AgentActivity) => (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5 shrink-0"
      style={{ color: `hsl(${parseInt(activity.actorId.slice(0, 6), 16) % 360} 48% 38%)` }}
    >
      <path d="m3 2 5 18 4-7 8-2Z" fill="currentColor" stroke="white" strokeWidth="1.5" />
      <circle cx="18" cy="19" r="3" fill="currentColor" stroke="white" />
    </svg>
  );
  const title = (activity: AgentActivity) =>
    `${activity.actorName}${activity.ownerName ? ` · ${activity.ownerName}` : ""} · ${activityLabels[activity.phase]}`;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[17] overflow-hidden"
      data-native-agent-cursors
    >
      {markers.map((marker) => (
        <div
          key={marker.activities.map((value) => value.actorId).join(":")}
          className="pointer-events-auto absolute"
          style={{ left: marker.x, top: marker.y }}
          data-canvas-control
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {marker.activities.length === 1 ? (
            <button
              className="group flex items-center gap-1 rounded-md focus-visible:outline-2 focus-visible:outline-accent"
              title={title(marker.activities[0])}
              aria-label={`Open thread: ${title(marker.activities[0])}`}
              onClick={() => onOpen(marker.activities[0].threadId!)}
            >
              {cursor(marker.activities[0])}
              <span className="hidden max-w-48 truncate rounded-md border border-primary-grey bg-surface px-2 py-1 text-[11px] shadow-sm group-hover:block group-focus-visible:block">
                {title(marker.activities[0])}
              </span>
            </button>
          ) : (
            <details className="rounded-lg border border-primary-grey bg-surface text-xs shadow-sm">
              <summary
                className="flex cursor-pointer items-center gap-1 px-2 py-1"
                aria-label={`${marker.activities.length} agents working here`}
              >
                {cursor(marker.activities[0])}
                {marker.activities.length} agents
              </summary>
              <ul className="max-h-48 max-w-64 overflow-auto p-1">
                {marker.activities.map((activity) => (
                  <li key={activity.agentId}>
                    <button
                      className="w-full rounded px-2 py-2 text-left hover:bg-hover-surface"
                      onClick={() => onOpen(activity.threadId!)}
                    >
                      {title(activity)}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
