"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";
import { nodePageId, type DesignDocument, type DesignNode } from "@/lib/design/document";
import {
  activityLabels,
  activityTerminal,
  activityVisible,
  activityWorking,
  type AgentActivity,
  type AgentActivityStore,
} from "@/lib/realtime/agent-activity";
import { canvasElements } from "./canvas-elements";
import styles from "./agent-activity-overlay.module.css";

type Bounds = { left: number; top: number; width: number; height: number };
type Region = { key: string; activity: AgentActivity; node?: DesignNode; root?: DesignNode };
function label(activity: AgentActivity, revision: number) {
  if (activity.phase === "published" && activity.revision && activity.revision > revision)
    return "Published · Updating canvas";
  const metadata = ["rename_file", "move_file"].includes(activity.tool);
  if (activity.phase === "editing" && metadata) return "Updating file";
  if (activity.phase === "staged" && activity.tool === "put_asset") return "Asset received";
  if (activity.phase === "completed")
    return activity.tool.startsWith("get_") || activity.tool.startsWith("list_")
      ? "Read file"
      : activity.tool === "export_component"
        ? "Exported component"
        : metadata
          ? "Updated file"
          : "Updated layers";
  return activityLabels[activity.phase];
}
function ActivityDetails({
  activity,
  target,
  revision,
}: {
  activity: AgentActivity;
  target?: string;
  revision: number;
}) {
  return (
    <div
      className="mt-1 max-h-48 w-72 max-w-full overflow-auto rounded-lg border border-primary-grey/70 bg-surface p-3 text-xs leading-5 shadow-sm"
      data-agent-activity-details
    >
      <p>{target ?? "Current file"}</p>
      <p className="text-secondary-ink">{label(activity, revision)}</p>
      {activity.sourceProject && (
        <p className="break-words text-secondary-ink">
          {activity.sourceProject}
          {activity.sourceRoute && <> · {activity.sourceRoute}</>}
        </p>
      )}
      {!activity.sourceProject && activity.sourceRoute && (
        <p className="break-words text-secondary-ink">{activity.sourceRoute}</p>
      )}
      {(activity.nodeCount !== undefined || activity.assetCount !== undefined) && (
        <p className="text-secondary-ink">
          {activity.nodeCount !== undefined &&
            `${activity.nodeCount} ${activity.nodeCount === 1 ? "layer" : "layers"}${activity.phase === "staged" ? " staged" : ""}`}
          {activity.nodeCount !== undefined && activity.assetCount !== undefined && " · "}
          {activity.assetCount !== undefined &&
            `${activity.assetCount} ${activity.assetCount === 1 ? "asset" : "assets"}${activity.tool === "put_asset" && activity.phase === "staged" ? " received" : ""}`}
        </p>
      )}
      {Boolean(activity.sourcePaths?.length) && (
        <ul className="mt-1 space-y-1">
          {activity.sourcePaths!.map((path) => (
            <li key={path} className="break-words text-secondary-ink">
              {path}
            </li>
          ))}
        </ul>
      )}
      {Boolean(activity.warningCount || activity.issueCount) && (
        <p className="mt-1 text-secondary-ink">
          {activity.issueCount ?? 0} layout issues · {activity.warningCount ?? 0} warnings
        </p>
      )}
      {activity.phase === "staged" && (
        <p className="mt-1 text-secondary-ink">Waiting for the next MCP call.</p>
      )}
      {activity.phase === "failed" && (
        <p className="mt-1 text-secondary-ink">
          The call failed. The agent can correct it and retry.
        </p>
      )}
    </div>
  );
}

/** Activity subscribes here, never in the editor, artwork, or panel trees. */
export function AgentActivityOverlay({
  store,
  document,
  revision,
  pageId,
  view,
  viewport,
  panelsOpen,
}: {
  store: AgentActivityStore;
  document: DesignDocument;
  revision: number;
  pageId: string;
  view: { x: number; y: number; zoom: number };
  viewport: React.RefObject<HTMLDivElement | null>;
  panelsOpen: boolean;
}) {
  const activities = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const [clock, tick] = useReducer((value) => value + 1, 0);
  const [hidden, setHidden] = useState(false);
  const [bounds, setBounds] = useState<Map<string, Bounds>>(() => new Map());
  const index = useMemo(
    () => new Map(document.nodes.map((node) => [node.id, node])),
    [document.nodes],
  );
  const importRoots = useMemo(
    () =>
      new Map(
        document.nodes
          .filter((node) => node.parentId === null && node.importKey)
          .map((node) => [node.importKey!, node]),
      ),
    [document.nodes],
  );
  const regions = useMemo(() => {
    const grouped = new Map<string, Region>();
    // A quick concurrent read must not hide a still-running edit on the same frame.
    for (const activity of activities
      .filter((activity) => !activity.threadId)
      .sort(
        (a, b) =>
          Number(activityWorking(b)) - Number(activityWorking(a)) ||
          b.updatedAt - a.updatedAt ||
          b.version - a.version,
      )) {
      const node =
        activity.nodeIds?.map((id) => index.get(id)).find(Boolean) ??
        (activity.sourceProject && activity.sourceRoute
          ? importRoots.get(`${activity.sourceProject}:${activity.sourceRoute}`)
          : undefined);
      let root = node;
      const visited = new Set<string>();
      while (root?.parentId && !visited.has(root.id)) {
        visited.add(root.id);
        root = index.get(root.parentId);
      }
      const key = `${activity.actorId}:${activity.importId ?? root?.id ?? "file"}`;
      if (!grouped.has(key)) grouped.set(key, { key, activity, node, root });
    }
    return [...grouped.values()];
  }, [activities, importRoots, index]);
  const geometryKey = regions.map((region) => `${region.key}:${region.root?.id ?? ""}`).join("|");
  // Phase/counter messages don't change targets or reconnect geometry observers.
  const targets = useMemo(
    () => regions.map(({ key, root }) => ({ key, root })).slice(0, 10),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geometryKey, document.nodes],
  );
  const measure = useCallback(() => {
    const canvas = viewport.current;
    if (!canvas || !targets.length) return;
    const origin = canvas.getBoundingClientRect(),
      elements = canvasElements(canvas),
      next = new Map<string, Bounds>();
    for (const region of targets) {
      if (!region.root || nodePageId(region.root) !== pageId) continue;
      const element = elements.get(region.root.id);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      if (
        box.right <= origin.left ||
        box.left >= origin.right ||
        box.bottom <= origin.top ||
        box.top >= origin.bottom
      )
        continue;
      next.set(region.key, {
        left: box.left - origin.left,
        top: box.top - origin.top,
        width: box.width,
        height: box.height,
      });
    }
    setBounds((before) =>
      before.size === next.size &&
      [...next].every(([key, box]) => {
        const previous = before.get(key);
        return (
          previous &&
          previous.left === box.left &&
          previous.top === box.top &&
          previous.width === box.width &&
          previous.height === box.height
        );
      })
        ? before
        : next,
    );
  }, [targets, pageId, viewport]);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [measure, view]);
  useEffect(() => {
    if (!targets.length || !viewport.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current);
    for (const target of targets) {
      const element = target.root && canvasElements(viewport.current).get(target.root.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [measure, targets, viewport]);
  useEffect(() => {
    if (!activities.length) return;
    const now = Date.now();
    const deadlines = activities
      .flatMap((activity) => [
        activity.expiresAt,
        ...(activityTerminal(activity) ? [activity.updatedAt + 6000] : []),
      ])
      .filter((time) => time > now);
    if (!deadlines.length) return;
    const timer = setTimeout(tick, Math.min(...deadlines) - now + 20);
    return () => clearTimeout(timer);
  }, [activities, clock]);
  useEffect(() => {
    const visibility = () => setHidden(window.document.hidden);
    window.document.addEventListener("visibilitychange", visibility);
    return () => window.document.removeEventListener("visibilitychange", visibility);
  }, []);
  const visible = regions.filter((region) => activityVisible(region.activity));
  if (!visible.length) return null;
  const anchored = visible.filter((region) => bounds.has(region.key)).slice(0, 3);
  const fallback = visible.filter((region) => !anchored.includes(region));
  const summary = (region: Region) =>
    `${region.activity.actorName} · ${label(region.activity, revision)}${region.node && region.activity.phase === "editing" ? ` · ${region.node.name}` : region.activity.sourceRoute ? ` · ${region.activity.sourceRoute}` : ""}`;
  return (
    <div
      data-agent-activity-overlay
      data-hidden={hidden}
      className={`${styles.overlay} pointer-events-none absolute inset-0 z-[16] overflow-hidden`}
    >
      {anchored.map((region) => {
        const box = bounds.get(region.key)!;
        return (
          <div key={region.key}>
            <div
              data-agent-target={region.root?.id}
              aria-hidden="true"
              className="absolute border border-primary-orange transition-opacity duration-200 motion-reduce:transition-none"
              style={{ ...box, opacity: activityTerminal(region.activity) ? 0 : 0.65 }}
            />
            <details
              data-agent-activity={region.activity.phase}
              data-working={activityWorking(region.activity)}
              data-canvas-control
              className={`${styles.marker} pointer-events-auto absolute max-w-[calc(100%-1.5rem)]`}
              style={{
                left: Math.max(
                  12,
                  Math.min(box.left, (viewport.current?.clientWidth ?? 320) - 300),
                ),
                top: Math.max(
                  12,
                  Math.min(box.top - 38, (viewport.current?.clientHeight ?? 500) - 42),
                ),
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <summary className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-primary-grey/70 bg-surface px-2.5 py-1.5 text-[11px] leading-4 shadow-sm focus-visible:outline-2 focus-visible:outline-primary-orange">
                <span className={styles.dot} aria-hidden="true" />
                <span className="truncate">{summary(region)}</span>
              </summary>
              <div
                className={
                  box.top > (viewport.current?.clientHeight ?? 500) - 260
                    ? "absolute bottom-full mb-1 w-72 max-w-full"
                    : ""
                }
              >
                <ActivityDetails
                  activity={region.activity}
                  target={region.node?.name ?? region.root?.name}
                  revision={revision}
                />
              </div>
            </details>
          </div>
        );
      })}
      {fallback.length > 0 && (
        <details
          data-agent-fallback
          data-agent-activity={fallback[0].activity.phase}
          data-working={fallback.some((region) => activityWorking(region.activity))}
          data-canvas-control
          className={`${styles.marker} pointer-events-auto absolute bottom-5`}
          style={{ left: panelsOpen ? 12 : 72, maxWidth: `calc(100% - ${panelsOpen ? 24 : 84}px)` }}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <summary className="flex h-10 min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-primary-grey/70 bg-surface px-2.5 py-1.5 text-[11px] leading-4 shadow-sm focus-visible:outline-2 focus-visible:outline-primary-orange">
            <span className={styles.dot} aria-hidden="true" />
            <span className="truncate">
              {summary(fallback[0])}
              {fallback.length > 1 && ` · +${fallback.length - 1}`}
            </span>
          </summary>
          <div className="absolute bottom-full mb-1 max-h-64 w-72 max-w-full overflow-auto">
            {fallback.map((region) => (
              <ActivityDetails
                key={region.key}
                activity={region.activity}
                target={
                  region.root
                    ? `${region.root.name}${nodePageId(region.root) !== pageId ? " · Another page" : " · Outside view"}`
                    : undefined
                }
                revision={revision}
              />
            ))}
          </div>
        </details>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {visible
          .map((region) => `${region.activity.actorName}: ${label(region.activity, revision)}`)
          .join(". ")}
      </span>
    </div>
  );
}
