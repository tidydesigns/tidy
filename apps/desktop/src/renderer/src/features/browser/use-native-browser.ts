import { useLayoutEffect, type RefObject } from "react";
import type { BrowserAPI, BrowserScope } from "../../../../shared/contracts/browser";

const overlaySelector =
  '[aria-modal="true"], [role="menu"], [role="listbox"], [role="dialog"], [popover], dialog';
const containsOverlay = (node: Node) =>
  node instanceof Element &&
  (node.matches(overlaySelector) || Boolean(node.querySelector(overlaySelector)));

/** Layout crosses IPC only when geometry or an overlapping app overlay changes. */
export function useNativeBrowser({
  api,
  scope,
  element,
  enabled,
  viewport,
}: {
  api: BrowserAPI;
  scope: BrowserScope;
  element: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  viewport: { width: number; height: number } | null;
}) {
  useLayoutEffect(() => {
    const target = element.current;
    if (!api.present || !enabled || !target) return;
    let previous = "";
    let frame = 0;
    let overlayElements: Element[] = [];
    const update = () => {
      frame = 0;
      const rect = target.getBoundingClientRect();
      const availableWidth = Math.max(0, Math.min(rect.width, innerWidth - rect.x));
      const availableHeight = Math.max(0, Math.min(rect.height, innerHeight - rect.y));
      const scale = viewport
        ? Math.min(1, availableWidth / viewport.width, availableHeight / viewport.height)
        : 1;
      const width = viewport ? Math.round(viewport.width * scale) : availableWidth;
      const height = viewport ? Math.round(viewport.height * scale) : availableHeight;
      const x = rect.x + (availableWidth - width) / 2,
        y = rect.y;
      const occluded = overlayElements.some((overlay) => {
        // The workspace panel can itself be a dialog containing the native surface.
        if (overlay.contains(target)) return false;
        if (!overlay.checkVisibility({ visibilityProperty: true })) return false;
        const box = overlay.getBoundingClientRect();
        if (!box.width || !box.height) return false;
        return (
          overlay.getAttribute("aria-modal") === "true" ||
          overlay.matches(":modal") ||
          (box.left < x + width && box.right > x && box.top < y + height && box.bottom > y)
        );
      });
      const bounds =
        !document.hidden &&
        target.checkVisibility({ visibilityProperty: true }) &&
        width > 0 &&
        height > 0 &&
        x >= 0 &&
        y >= 0
          ? { x, y, width, height, zoom: scale, occluded, ...(viewport ? { viewport } : {}) }
          : null;
      const key = JSON.stringify(bounds);
      if (key !== previous) {
        previous = key;
        api.present!(scope, bounds);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const scroll = (event: Event) => {
      const scroller = event.target;
      if (
        scroller === document ||
        (scroller instanceof Element &&
          (scroller.contains(target) ||
            overlayElements.some((overlay) => scroller.contains(overlay))))
      )
        schedule();
    };
    const resize = new ResizeObserver(schedule);
    const overlayAttributes = new MutationObserver(schedule);
    const watchOverlays = () => {
      for (const overlay of overlayElements) resize.unobserve(overlay);
      overlayAttributes.disconnect();
      overlayElements = [...document.querySelectorAll(overlaySelector)];
      for (const overlay of overlayElements) {
        resize.observe(overlay);
        for (let ancestor: Element | null = overlay; ancestor; ancestor = ancestor.parentElement)
          overlayAttributes.observe(ancestor, {
            attributes: true,
            attributeFilter: ["style", "class", "hidden", "open", "aria-hidden"],
          });
      }
    };
    const overlays = new MutationObserver((records) => {
      if (
        !records.some(
          (record) =>
            record.type === "attributes" ||
            [...record.addedNodes, ...record.removedNodes].some(containsOverlay),
        )
      )
        return;
      watchOverlays();
      schedule();
    });
    // Streaming text and unrelated chat mutations require no layout read or IPC.
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "aria-modal", "popover"],
    });
    const ancestors = new MutationObserver(schedule);
    for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement)
      ancestors.observe(ancestor, {
        attributes: true,
        attributeFilter: ["style", "class", "hidden"],
      });
    resize.observe(target);
    watchOverlays();
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("visibilitychange", schedule);
    document.addEventListener("toggle", schedule, true);
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      overlays.disconnect();
      overlayAttributes.disconnect();
      ancestors.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("visibilitychange", schedule);
      document.removeEventListener("toggle", schedule, true);
      api.present!(scope, null);
    };
  }, [api, scope.projectId, scope.threadId, enabled, viewport?.width, viewport?.height]);
}
