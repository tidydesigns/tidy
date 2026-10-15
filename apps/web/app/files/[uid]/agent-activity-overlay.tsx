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
import { layoutPresences, presenceDetailsLayout } from "./agent-presence-layout";
import { canvasElements } from "./canvas-elements";
import styles from "./agent-activity-overlay.module.css";

type Bounds = { left: number; top: number; width: number; height: number };
type Region = { key: string; activity: AgentActivity; node?: DesignNode; root?: DesignNode };
type Geometry = { focus?: Bounds; nodeId?: string; width: number; height: number };
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
    <div className={styles.detailItem} data-agent-activity-details>
      <p>{target ?? "Current file"}</p>
      <p className="text-secondary-ink">{presenceLabel(activity, revision)}</p>
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
            `${activity.nodeCount} ${activity.nodeCount === 1 ? "layer" : "layers"}`}
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
          {activity.issueCount ?? 0}{" "}
          <span data-ph-public style={{ display: "contents" }}>
            layout issues ·{" "}
          </span>
          {activity.warningCount ?? 0}{" "}
          <span data-ph-public style={{ display: "contents" }}>
            warnings
          </span>
        </p>
      )}
      {activity.phase === "staged" && (
        <p data-ph-public className="mt-1 text-secondary-ink">
          Layers are prepared. They’ll appear on the canvas when the agent places them.
        </p>
      )}
      {activity.phase === "failed" && (
        <p data-ph-public className="mt-1 text-secondary-ink">
          The call failed. The agent can correct it and retry.
        </p>
      )}
    </div>
  );
}

function PresenceMark({ activity }: { activity: AgentActivity }) {
  const done = ["completed", "published"].includes(activity.phase);
  const attention = ["failed", "unavailable"].includes(activity.phase);
  return done || attention || activity.phase === "aborted" ? (
    <svg
      data-ph-public
      viewBox="0 0 16 16"
      className={styles.result}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={done ? "m3 8 3 3 7-7" : attention ? "M8 3v6m0 3h.01" : "m4 4 8 8m0-8-8 8"} />
    </svg>
  ) : (
    <span className={styles.pulse} data-agent-pulse aria-hidden="true" />
  );
}

function identityWidth(activity: AgentActivity) {
  // Reserve a bounded slot without measuring text or waiting for fonts.
  const nameWidth = Math.min(160, Math.max(72, activity.actorName.length * 7 + 30));
  return ["failed", "unavailable"].includes(activity.phase) ? nameWidth + 90 : nameWidth;
}

function presenceLabel(activity: AgentActivity, revision: number) {
  if (activity.phase === "editing" && !["rename_file", "move_file"].includes(activity.tool))
    return "Editing layers";
  if (activity.phase === "receiving") return "Receiving layers";
  if (activity.phase === "staged")
    return activity.tool === "put_asset"
      ? "Asset ready"
      : activity.nodeCount
        ? `${activity.nodeCount} ${activity.nodeCount === 1 ? "layer" : "layers"} ready`
        : "Preparing";
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
  children,
}: {
  target: string;
  view: string;
  x: number;
  y: number;
  width: number;
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
        duration: 200,
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
    <div ref={ref} className={styles.position} data-agent-position style={{ transform, width }}>
      {children}
    </div>
  );
}

type OverlayProps = {
  store: AgentActivityStore;
  document: DesignDocument;
  revision: number;
  pageId: string;
  view: { x: number; y: number; zoom: number };
  viewport: React.RefObject<HTMLDivElement | null>;
  panelsOpen: boolean;
};

/** No document indexing, layout reads, observers, or animation when idle/hidden.
 * Activity subscribes here, never in the editor, artwork, or panel trees. */
export function AgentActivityOverlay(props: OverlayProps) {
  const { store } = props;
  const [clock, setClock] = useState(() => Date.now());
  const [hidden, setHidden] = useState(
    () => typeof window !== "undefined" && window.document.hidden,
  );
  const subscribe = useCallback(
    (notify: () => void) =>
      store.subscribe(() => {
        setClock(Date.now());
        notify();
      }),
    [store],
  );
  const activities = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
  const presences = useMemo(() => agentPresences(activities, clock), [activities, clock]);
  useEffect(() => {
    if (hidden || !presences.length) return;
    const now = Date.now();
    const deadlines = presences
      .flatMap((activity) => [presenceDeadline(activity) - 180, presenceDeadline(activity)])
      .filter((time) => time > now);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(...deadlines) - now + 10);
    return () => clearTimeout(timer);
  }, [presences, hidden]);
  useEffect(() => {
    const visibility = () => {
      setHidden(window.document.hidden);
      setClock(Date.now());
    };
    window.document.addEventListener("visibilitychange", visibility);
    return () => window.document.removeEventListener("visibilitychange", visibility);
  }, []);
  return !hidden && presences.length ? (
    <VisibleAgentPresence {...props} presences={presences} clock={clock} />
  ) : null;
}

function VisibleAgentPresence({
  document,
  revision,
  pageId,
  view,
  viewport,
  panelsOpen,
  presences,
  clock,
}: OverlayProps & { presences: AgentActivity[]; clock: number }) {
  const overlay = useRef<HTMLDivElement>(null);
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
      presences.map((activity): Region => {
        // Staged IDs live in a separate namespace until publication. They can
        // match existing layer IDs without referring to those canvas layers.
        const onCanvas = !activity.importId || activity.phase === "published";
        const node = onCanvas
          ? (activity.nodeIds?.map((id) => index.get(id)).find(Boolean) ??
            (activity.sourceProject && activity.sourceRoute
              ? importRoots.get(`${activity.sourceProject}:${activity.sourceRoute}`)
              : undefined))
          : undefined;
        let root = node;
        const visited = new Set<string>();
        while (root?.parentId && !visited.has(root.id)) {
          visited.add(root.id);
          root = index.get(root.parentId);
        }
        return { key: activity.actorId, activity, node, root };
      }),
    [presences, importRoots, index],
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
  const measure = useCallback(
    (canvas: HTMLDivElement | null) => {
      if (!canvas || !targets.length) return;
      const origin = canvas.getBoundingClientRect(),
        elements = canvasElements(canvas),
        next = new Map<string, Geometry>(),
        boxes = new Map<string, Bounds | undefined>();
      const bounds = (id?: string) => {
        if (!id) return undefined;
        if (boxes.has(id)) return boxes.get(id);
        const element = elements.get(id);
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
        const result = {
          left: box.left - origin.left,
          top: box.top - origin.top,
          width: box.width,
          height: box.height,
        };
        boxes.set(id, result);
        return result;
      };
      for (const region of targets) {
        const onPage = region.root && nodePageId(region.root) === pageId;
        next.set(region.key, {
          nodeId: region.node?.id,
          width: origin.width,
          height: origin.height,
          focus: onPage ? bounds(region.node?.id) : undefined,
        });
      }
      setGeometry((before) =>
        before.size === next.size &&
        [...next].every(([key, value]) => {
          const old = before.get(key);
          return (
            old !== undefined &&
            old.nodeId === value.nodeId &&
            old.width === value.width &&
            old.height === value.height &&
            old.focus?.left === value.focus?.left &&
            old.focus?.top === value.focus?.top &&
            old.focus?.width === value.focus?.width &&
            old.focus?.height === value.focus?.height
          );
        })
          ? before
          : next,
      );
    },
    [targets, pageId],
  );
  // Pan/zoom and document changes attach in the same paint. Resize bursts are
  // coalesced; activity phase/count changes do not schedule geometry work.
  // Layout measurement is intentionally synchronous, so the highlight never
  // paints at the previous zoom or target before its bounds are known.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useLayoutEffect(() => measure(viewport.current), [measure, view, viewport]);
  useEffect(() => {
    const canvas = viewport.current;
    if (!canvas) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure(canvas);
        });
    });
    observer.observe(canvas);
    const elements = canvasElements(canvas);
    const observed = new Set<HTMLElement>();
    for (const target of targets) {
      const element = target.node && elements.get(target.node.id);
      if (element && !observed.has(element)) {
        observed.add(element);
        observer.observe(element);
      }
    }
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [measure, targets, viewport]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      overlay.current?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((detail) => {
        if (!detail.contains(event.target as Node)) detail.open = false;
      });
    };
    window.document.addEventListener("pointerdown", dismiss, true);
    return () => window.document.removeEventListener("pointerdown", dismiss, true);
  }, []);
  const canvasSize = geometry.values().next().value ?? {
    width: viewport.current?.clientWidth ?? 320,
    height: viewport.current?.clientHeight ?? 500,
  };
  const { placements, margin } = layoutPresences(
    regions.map((region) => ({
      key: region.key,
      width: identityWidth(region.activity),
      focus: geometry.get(region.key)?.focus,
    })),
    canvasSize,
    panelsOpen,
  );
  const anchored = regions.filter((region) => placements.has(region.key));
  const fallback = regions.filter((region) => !anchored.includes(region));
  const shown = [...anchored, ...fallback.slice(0, 1)];
  return (
    <div
      data-agent-activity-overlay
      ref={overlay}
      className={`${styles.overlay} pointer-events-none absolute inset-0 z-[16] overflow-hidden`}
    >
      {shown.map((region) => {
        const measured = geometry.get(region.key);
        const unanchored = !anchored.includes(region);
        const focus = unanchored ? undefined : measured?.focus;
        const width = measured?.width ?? viewport.current?.clientWidth ?? 320;
        const height = measured?.height ?? viewport.current?.clientHeight ?? 500;
        const attention = ["failed", "unavailable"].includes(region.activity.phase);
        const badgeWidth = Math.max(
          0,
          Math.min(
            identityWidth(region.activity) + (unanchored && fallback.length > 1 ? 24 : 0),
            width - 24,
          ),
        );
        const placement = placements.get(region.key);
        const x = placement?.left ?? margin!.left;
        const y = placement?.top ?? margin!.top;
        const { above, ...detailsStyle } = presenceDetailsLayout(x, y, { width, height });
        const retiring = presenceDeadline(region.activity) - clock <= 180;
        const terminal = activityTerminal(region.activity);
        const target = region.node?.name ?? region.root?.name;
        const status = presenceLabel(region.activity, revision);
        const context =
          unanchored && region.root
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
              <div
                data-agent-target={measured?.nodeId}
                aria-hidden="true"
                className={styles.focus}
                style={focus}
              />
            )}
            <PresencePosition
              target={`${pageId}:${unanchored ? "edge" : measured?.nodeId}`}
              view={`${view.x}:${view.y}:${view.zoom}:${width}:${height}`}
              x={x}
              y={y}
              width={badgeWidth}
            >
              <details
                data-agent-activity={region.activity.phase}
                data-agent-actor={region.key}
                data-agent-fallback={unanchored || undefined}
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
                  title={`${status}${context ? ` · ${context}` : ""}`}
                  aria-label={`${region.activity.actorName}: ${status}${context ? ` · ${context}` : ""}. Activity details`}
                >
                  <span className={styles.name}>{region.activity.actorName}</span>
                  <PresenceMark activity={region.activity} />
                  {attention && <span className={styles.status}>{status}</span>}
                  {unanchored && fallback.length > 1 && (
                    <span className={styles.count}>
                      <span data-ph-public style={{ display: "contents" }}>
                        +
                      </span>
                      {fallback.length - 1}
                    </span>
                  )}
                </summary>
                <div className={styles.details} data-above={above} style={detailsStyle}>
                  {(unanchored ? fallback : [region]).map((item) => (
                    <ActivityDetails
                      key={item.key}
                      activity={item.activity}
                      target={`${item.activity.actorName} · ${item.node?.name ?? item.root?.name ?? "Current file"}`}
                      revision={revision}
                    />
                  ))}
                </div>
              </details>
              <svg
                data-ph-public
                className={styles.cursor}
                viewBox="0 0 28 32"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 3 23 17l-9 1-4 9L4 3Z"
                  fill="currentColor"
                  stroke="white"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
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
