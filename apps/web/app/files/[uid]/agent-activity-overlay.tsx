"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  useState,
  useSyncExternalStore,
} from "react";
import { nodePageId, type DesignDocument, type DesignNode } from "@/lib/design/document";
import {
  activityLabels,
  activityTerminal,
  activityWorking,
  type AgentActivity,
  type AgentActivityStore,
} from "@/lib/realtime/agent-activity";
import { agentPresences, presenceColor, presenceDeadline } from "@/lib/realtime/agent-presence";
import { placePresence, type PresenceBox } from "./agent-presence-layout";
import { canvasElements } from "./canvas-elements";
import styles from "./agent-activity-overlay.module.css";

type Bounds = { left: number; top: number; width: number; height: number };
type Region = { key: string; activity: AgentActivity; node?: DesignNode; root?: DesignNode };
type Geometry = { frame?: Bounds; focus?: Bounds; nodeId?: string; width: number; height: number };
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
        <p className="mt-1 text-secondary-ink">
          Layers are prepared. They’ll appear on the canvas when the agent places them.
        </p>
      )}
      {activity.phase === "failed" && (
        <p className="mt-1 text-secondary-ink">
          The call failed. The agent can correct it and retry.
        </p>
      )}
    </div>
  );
}

function PresenceMark({ activity }: { activity: AgentActivity }) {
  const done = ["completed", "published"].includes(activity.phase);
  const attention = ["failed", "unavailable"].includes(activity.phase);
  return (
    <span className={styles.avatar} aria-hidden="true">
      {done || attention || activity.phase === "aborted" ? (
        <svg
          viewBox="0 0 24 24"
          className={styles.result}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={done ? "m6 12 4 4 8-8" : attention ? "M12 6v7m0 4h.01" : "M8 8l8 8m0-8-8 8"} />
        </svg>
      ) : (
        <span className={styles.spark} data-agent-spark>
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );
}

function presenceLabel(activity: AgentActivity, revision: number) {
  if (activity.phase === "editing" && !["rename_file", "move_file"].includes(activity.tool))
    return "Designing";
  if (activity.phase === "receiving") return "Building layers";
  if (activity.phase === "staged")
    return activity.tool === "put_asset"
      ? "Asset ready"
      : activity.nodeCount
        ? `${activity.nodeCount} ${activity.nodeCount === 1 ? "layer" : "layers"} prepared`
        : "Waiting for layers";
  if (activity.phase === "publishing") return "Placing on canvas";
  if (activity.phase === "published")
    return activity.revision && activity.revision > revision
      ? "Updating canvas"
      : "Added to canvas";
  if (activity.phase === "failed") return "Needs attention";
  return label(activity, revision);
}

/** Only a change of work target travels. User pan/zoom stays attached instantly. */
function PresencePosition({
  target,
  view,
  x,
  y,
  width,
  docked,
  children,
}: {
  target: string;
  view: string;
  x: number;
  y: number;
  width: number;
  docked: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<{ target: string; view: string; transform: string } | null>(null);
  const transform = `translate(${x}px, ${y}px)`;
  useLayoutEffect(() => {
    const element = ref.current;
    const before = previous.current;
    previous.current = { target, view, transform };
    if (!element || !before) return;
    const animations = element.getAnimations();
    const from = animations.length ? getComputedStyle(element).transform : before.transform;
    for (const animation of animations) animation.cancel();
    if (
      before.target !== target &&
      before.view === view &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      element.animate([{ transform: from }, { transform }], {
        duration: 260,
        easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      });
    }
  }, [target, view, transform]);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const cancel = () => {
      if (media.matches) ref.current?.getAnimations().forEach((animation) => animation.cancel());
    };
    media.addEventListener("change", cancel);
    return () => media.removeEventListener("change", cancel);
  }, []);
  return (
    <div
      ref={ref}
      className={styles.position}
      data-agent-position
      data-docked={docked}
      style={{ transform, width }}
    >
      {children}
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
  const [clock, setClock] = useState(() => Date.now());
  const subscribe = useCallback(
    (notify: () => void) =>
      store.subscribe(() => {
        setClock(Date.now());
        notify();
      }),
    [store],
  );
  const activities = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
  const [hidden, setHidden] = useState(false);
  const [geometry, setGeometry] = useState<Map<string, Geometry>>(() => new Map());
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
  // Re-evaluate at expiry boundaries as well as on messages. Stale activity must
  // not mask a teammate's next operation or reappear after their departure.
  const regions = useMemo(
    () =>
      agentPresences(activities, clock).map((activity): Region => {
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
        return { key: activity.actorId, activity, node, root };
      }),
    [activities, importRoots, index, clock],
  );
  const geometryKey = regions
    .map(({ key, root, node }) => `${key}:${root?.id}:${node?.id}`)
    .join("|");
  const targets = useMemo(
    () => regions.map(({ key, root, node }) => ({ key, root, node })).slice(0, 10),
    // Counter/phase messages do not reconnect geometry observers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geometryKey, document.nodes],
  );
  const measure = useCallback(() => {
    const canvas = viewport.current;
    if (!canvas || !targets.length) return;
    const origin = canvas.getBoundingClientRect(),
      elements = canvasElements(canvas),
      next = new Map<string, Geometry>();
    const bounds = (id?: string) => {
      const element = id && elements.get(id);
      if (!element) return undefined;
      const box = element.getBoundingClientRect();
      if (
        box.width === 0 ||
        box.height === 0 ||
        box.right <= origin.left ||
        box.left >= origin.right ||
        box.bottom <= origin.top ||
        box.top >= origin.bottom
      )
        return undefined;
      return {
        left: box.left - origin.left,
        top: box.top - origin.top,
        width: box.width,
        height: box.height,
      };
    };
    for (const region of targets) {
      const onPage = region.root && nodePageId(region.root) === pageId;
      next.set(region.key, {
        nodeId: region.node?.id,
        width: origin.width,
        height: origin.height,
        frame: onPage ? bounds(region.root?.id) : undefined,
        focus: onPage ? bounds(region.node?.id) : undefined,
      });
    }
    setGeometry((before) =>
      JSON.stringify([...before]) === JSON.stringify([...next]) ? before : next,
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
    const elements = canvasElements(viewport.current);
    for (const target of targets) {
      for (const id of new Set([target.root?.id, target.node?.id])) {
        const element = id && elements.get(id);
        if (element) observer.observe(element);
      }
    }
    return () => observer.disconnect();
  }, [measure, targets, viewport]);
  useEffect(() => {
    if (!activities.length) return;
    const now = Date.now();
    const deadlines = activities
      .flatMap((activity) => [presenceDeadline(activity) - 240, presenceDeadline(activity)])
      .filter((time) => time > now);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(...deadlines) - now + 10);
    return () => clearTimeout(timer);
  }, [activities, clock]);
  useEffect(() => {
    const visibility = () => {
      setHidden(window.document.hidden);
      setClock(Date.now());
    };
    window.document.addEventListener("visibilitychange", visibility);
    return () => window.document.removeEventListener("visibilitychange", visibility);
  }, []);
  if (!regions.length) return null;
  const placements = new Map<string, PresenceBox>();
  const anchored = regions.filter((region) => {
    const measured = geometry.get(region.key);
    if (!measured?.focus || placements.size >= 3) return false;
    const box = placePresence(measured.focus, measured, [...placements.values()]);
    if (!box) return false;
    placements.set(region.key, box);
    return true;
  });
  const fallback = regions.filter((region) => !anchored.includes(region));
  const shown = [...anchored, ...fallback.slice(0, 1)];
  return (
    <div
      data-agent-activity-overlay
      data-hidden={hidden}
      className={`${styles.overlay} pointer-events-none absolute inset-0 z-[16] overflow-hidden`}
    >
      {shown.map((region) => {
        const measured = geometry.get(region.key);
        const docked = !anchored.includes(region);
        const focus = docked ? undefined : measured?.focus;
        const width = measured?.width ?? viewport.current?.clientWidth ?? 320;
        const height = measured?.height ?? viewport.current?.clientHeight ?? 500;
        const badgeWidth = Math.max(0, Math.min(220, width - 24));
        const placement = placements.get(region.key);
        const x =
          placement?.left ?? Math.max(12, Math.min(panelsOpen ? 20 : 72, width - badgeWidth - 12));
        const y = placement?.top ?? Math.max(12, height - 84);
        const detailsWidth = Math.max(0, Math.min(288, width - 24));
        const retiring = presenceDeadline(region.activity) - clock <= 240;
        const terminal = activityTerminal(region.activity);
        const target = region.node?.name ?? region.root?.name;
        const status = presenceLabel(region.activity, revision);
        const context =
          docked && region.root
            ? nodePageId(region.root) !== pageId
              ? "Another page"
              : "Outside view"
            : target;
        return (
          <div
            key={region.key}
            className={styles.teammate}
            data-tone={presenceColor(region.activity.actorId)}
            data-working={activityWorking(region.activity)}
            data-terminal={terminal}
            data-retiring={retiring}
            data-phase={region.activity.phase}
          >
            {focus && (
              <>
                {measured?.frame && region.root?.id !== region.node?.id && (
                  <div aria-hidden="true" className={styles.frame} style={measured.frame} />
                )}
                <div
                  data-agent-target={measured?.nodeId}
                  aria-hidden="true"
                  className={styles.focus}
                  style={focus}
                >
                  <span className={styles.corners}>
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </>
            )}
            <PresencePosition
              target={`${pageId}:${docked ? "edge" : measured?.nodeId}`}
              view={`${view.x}:${view.y}:${view.zoom}:${width}:${height}`}
              x={x}
              y={y}
              width={badgeWidth}
              docked={docked}
            >
              <details
                data-agent-activity={region.activity.phase}
                data-agent-actor={region.key}
                data-agent-fallback={docked || undefined}
                data-working={activityWorking(region.activity)}
                data-canvas-control
                className={styles.marker}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Escape") {
                    event.currentTarget.open = false;
                    event.currentTarget.querySelector("summary")?.focus();
                  }
                }}
              >
                <summary
                  className={styles.identity}
                  aria-label={`${region.activity.actorName}: ${status}${context ? ` · ${context}` : ""}. Activity details`}
                >
                  <PresenceMark activity={region.activity} />
                  <span className={styles.caption}>
                    <span className={styles.name}>
                      <span className={styles.nameText}>{region.activity.actorName}</span>
                      {docked && fallback.length > 1 && (
                        <span className={styles.count}>+{fallback.length - 1}</span>
                      )}
                    </span>
                    <span
                      className={styles.status}
                      key={`${status}:${context}`}
                      title={context ? `${status} · ${context}` : status}
                    >
                      {status}
                      {context && (
                        <>
                          <span className={styles.separator}>·</span>
                          {context}
                        </>
                      )}
                    </span>
                  </span>
                  <svg
                    className={styles.chevron}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    aria-hidden="true"
                  >
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                </summary>
                <div
                  className={styles.details}
                  data-above={y > height - 280}
                  style={{
                    width: detailsWidth,
                    left: Math.min(0, width - x - detailsWidth - 12),
                    maxHeight: Math.min(240, y > height - 280 ? y - 20 : height - y - 68),
                  }}
                >
                  {(docked ? fallback : [region]).map((item) => (
                    <ActivityDetails
                      key={item.key}
                      activity={item.activity}
                      target={`${item.activity.actorName} · ${item.node?.name ?? item.root?.name ?? "Current file"}`}
                      revision={revision}
                    />
                  ))}
                </div>
              </details>
              {!docked && (
                <svg className={styles.cursor} viewBox="0 0 28 32" fill="none" aria-hidden="true">
                  <path
                    d="M4 3 23 17l-9 1-4 9L4 3Z"
                    fill="currentColor"
                    stroke="white"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </PresencePosition>
          </div>
        );
      })}
      <span role="status" aria-live="polite" className="sr-only">
        {regions
          .map(({ activity }) => `${activity.actorName}: ${presenceLabel(activity, revision)}`)
          .join(". ")}
      </span>
    </div>
  );
}
