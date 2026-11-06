import { useLayoutEffect, type RefObject } from "react";
import type { BrowserAPI, BrowserScope } from "../../../../shared/contracts/browser";

/** Only layout crosses IPC. Pixels and page input stay in Chromium's native view. */
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
    if (!api.present || !enabled || !element.current) return;
    let previous = "";
    let frame = 0;
    const update = () => {
      frame = 0;
      const target = element.current;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      // Native views are above DOM content. Yield the surface to app menus and dialogs.
      const covered =
        document.hidden ||
        Boolean(document.querySelector('[aria-modal="true"], [role="menu"], [role="listbox"]'));
      const scale = viewport
        ? Math.max(0.25, Math.min(1, rect.width / viewport.width, rect.height / viewport.height))
        : 1;
      const width = viewport
        ? Math.min(rect.width, Math.round(viewport.width * scale))
        : rect.width;
      const height = viewport
        ? Math.min(rect.height, Math.round(viewport.height * scale))
        : rect.height;
      const bounds =
        !document.hidden && rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0
          ? {
              x: rect.x + (rect.width - width) / 2,
              y: rect.y,
              width: Math.min(width, innerWidth - rect.x),
              height: Math.min(height, innerHeight - rect.y),
              zoom: scale,
              occluded: covered,
            }
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
    const resize = new ResizeObserver(schedule);
    resize.observe(element.current);
    const overlays = new MutationObserver(schedule);
    overlays.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      api.present!(scope, null);
    };
  }, [api, scope.projectId, scope.threadId, enabled, viewport?.width, viewport?.height]);
}
