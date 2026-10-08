"use client";

import { canvasElements } from "./canvas-elements";

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { DesignDocument } from "@/lib/design/document";
import type { PresenceStore } from "@/lib/realtime/presence-store";

export function CollaboratorOverlay({
  store,
  pageId,
  view,
  viewport,
  document,
  localSelection,
}: {
  store: PresenceStore;
  pageId: string;
  view: { x: number; y: number; zoom: number };
  viewport: React.RefObject<HTMLDivElement | null>;
  document: DesignDocument;
  localSelection: string[];
}) {
  const peers = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const decorations = useSyncExternalStore(
    store.subscribe,
    store.getDecorationsSnapshot,
    store.getServerSnapshot,
  );
  const decoration = useRef<HTMLDivElement>(null);
  const items = useRef(
    new Map<
      string,
      { element: HTMLElement; source?: HTMLElement; document?: DesignDocument; text?: string }
    >(),
  );
  const hidden = useRef(new Map<HTMLElement, string>());
  useLayoutEffect(
    () => () => {
      for (const [element, visibility] of hidden.current)
        element.style.setProperty("visibility", visibility);
      hidden.current.clear();
      items.current.clear();
    },
    [],
  );
  useLayoutEffect(() => {
    const canvas = viewport.current;
    const target = decoration.current;
    if (!canvas || !target) return;
    const peers = decorations.filter((item) => item.pageId === pageId && !item.away);
    if (!peers.length && !items.current.size && !hidden.current.size) return;
    const origin = canvas.getBoundingClientRect();
    const elements = canvasElements(canvas);
    const desired = new Set<string>();
    const conceal = new Set<HTMLElement>();
    const updates: (() => void)[] = [];
    // Batch all layout reads before writing overlay positions or visibility.
    for (const peer of peers) {
      const preview = peer.preview;
      if (preview) {
        const source = preview.nodeId ? elements.get(preview.nodeId) : undefined;
        const node = document.nodes.find((item) => item.id === preview.nodeId);
        const box = preview.box,
          bounds = source?.getBoundingClientRect();
        const key = `preview:${peer.sessionId}`;
        if (source && node && bounds && !localSelection.includes(node.id)) {
          desired.add(key);
          conceal.add(source);
          updates.push(() => {
            let item = items.current.get(key);
            if (
              !item ||
              item.source !== source ||
              item.document !== document ||
              item.text !== preview.text
            ) {
              item?.element.remove();
              const clone = source.cloneNode(true) as HTMLElement;
              clone.removeAttribute("data-node-id");
              clone.querySelectorAll("button, textarea").forEach((child) => child.remove());
              clone
                .querySelectorAll("[data-node-id]")
                .forEach((child) => child.removeAttribute("data-node-id"));
              if (preview.text !== undefined) clone.textContent = preview.text;
              item = { element: clone, source, document, text: preview.text };
              items.current.set(key, item);
              target.appendChild(clone);
            }
            item.element.dataset.remotePreview = peer.sessionId;
            Object.assign(item.element.style, {
              position: "absolute",
              left: `${bounds.left - origin.left + ((box?.x ?? node.box.x) - node.box.x) * view.zoom}px`,
              top: `${bounds.top - origin.top + ((box?.y ?? node.box.y) - node.box.y) * view.zoom}px`,
              width: `${box?.width ?? bounds.width / view.zoom}px`,
              height: `${box?.height ?? bounds.height / view.zoom}px`,
              transform: `scale(${view.zoom})`,
              transformOrigin: "top left",
              visibility: "visible",
              outline: `${1.5 / view.zoom}px solid ${peer.color}`,
              pointerEvents: "none",
            });
          });
        } else if (!preview.nodeId && box) {
          desired.add(key);
          updates.push(() => {
            let item = items.current.get(key);
            if (!item || item.source) {
              item?.element.remove();
              item = { element: window.document.createElement("div") };
              items.current.set(key, item);
              target.appendChild(item.element);
            }
            item.element.dataset.remotePreview = peer.sessionId;
            Object.assign(item.element.style, {
              position: "absolute",
              left: `${box.x * view.zoom + view.x}px`,
              top: `${box.y * view.zoom + view.y}px`,
              width: `${box.width * view.zoom}px`,
              height: `${box.height * view.zoom}px`,
              border: `1.5px solid ${peer.color}`,
              background: `${peer.color}15`,
            });
          });
        }
      }
      for (const id of peer.selectedIds) {
        if (preview?.nodeId === id && !localSelection.includes(id)) continue;
        const element = elements.get(id);
        if (!element) continue;
        const bounds = element.getBoundingClientRect(),
          key = `selection:${peer.sessionId}:${id}`;
        desired.add(key);
        updates.push(() => {
          let item = items.current.get(key);
          if (!item) {
            item = { element: window.document.createElement("div") };
            items.current.set(key, item);
            target.appendChild(item.element);
          }
          item.element.dataset.remoteSelection = `${peer.sessionId}:${id}`;
          Object.assign(item.element.style, {
            position: "absolute",
            left: `${bounds.left - origin.left}px`,
            top: `${bounds.top - origin.top}px`,
            width: `${bounds.width}px`,
            height: `${bounds.height}px`,
            border: `1.5px solid ${peer.color}`,
            borderRadius: "1px",
          });
        });
      }
    }
    updates.forEach((update) => update());
    for (const [key, item] of items.current)
      if (!desired.has(key)) {
        item.element.remove();
        items.current.delete(key);
      }
    for (const [element, visibility] of hidden.current)
      if (!conceal.has(element)) {
        element.style.setProperty("visibility", visibility);
        hidden.current.delete(element);
      }
    for (const element of conceal) {
      if (!hidden.current.has(element)) hidden.current.set(element, element.style.visibility);
      element.style.setProperty("visibility", "hidden");
    }
  }, [decorations, pageId, view, viewport, document, localSelection]);
  return (
    <div
      aria-hidden="true"
      data-collaborator-overlay
      className="pointer-events-none absolute inset-0 z-[15] overflow-hidden"
    >
      <div ref={decoration} />
      {peers
        .filter((peer) => peer.pageId === pageId && !peer.away && peer.cursor)
        .map((peer) => (
          <div
            key={peer.sessionId}
            data-collaborator-cursor={peer.name}
            className="absolute left-0 top-0 transition-transform duration-[45ms] ease-linear motion-reduce:transition-none"
            style={{
              transform: `translate(${peer.cursor!.x * view.zoom + view.x}px, ${peer.cursor!.y * view.zoom + view.y}px)`,
            }}
          >
            <svg width="18" height="23" viewBox="0 0 18 23" fill="none" className="drop-shadow-sm">
              <path
                d="M1.5 1.5 15.5 13l-6 .8-3 6.7-5-19Z"
                fill={peer.color}
                stroke="white"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
            <span
              className="absolute left-3 top-5 max-w-48 truncate rounded px-1.5 py-0.5 text-[11px] font-medium leading-4 text-on-accent shadow-sm"
              style={{ backgroundColor: peer.color }}
            >
              {peer.name}
            </span>
          </div>
        ))}
    </div>
  );
}
