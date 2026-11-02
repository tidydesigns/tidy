import { useLayoutEffect, useRef, type ReactNode } from "react";
import { resolveComposerControlsLayout, type ComposerControlWidth } from "./controls-layout";

export function ComposerControls({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    let widths: ComposerControlWidth[] = [];
    const buttons = () => [
      ...host.querySelectorAll<HTMLElement>(":scope > button, .harness-setting-trigger"),
    ];
    let compactCount = 0;
    let frame = 0;
    const fit = () => {
      const gap = Number.parseFloat(getComputedStyle(host).columnGap) || 0;
      const layout = resolveComposerControlsLayout({
        available: host.clientWidth,
        controls: widths,
        gap,
        previous: compactCount,
      });
      compactCount = layout.compactCount;
      host.dataset.compactCount = String(compactCount);
      host.dataset.overflow = String(layout.overflow);
      const steps = widths.filter((width) => width.priority !== undefined).length;
      buttons().forEach((button, index) => {
        const priority = widths[index]?.priority;
        button.dataset.compact = String(priority !== undefined && priority >= steps - compactCount);
        const label = button.getAttribute("aria-label");
        if (label) button.title = label;
      });
    };
    const measure = () => {
      const controls = buttons();
      const settings = controls.filter((button) =>
        button.classList.contains("harness-setting-trigger"),
      );
      widths = controls.map((button) => {
        if (!settings.includes(button)) {
          const natural = button.getBoundingClientRect().width;
          return { natural, compact: natural };
        }
        const style = getComputedStyle(button);
        const inset = [
          style.paddingLeft,
          style.paddingRight,
          style.borderLeftWidth,
          style.borderRightWidth,
        ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
        const children = [...button.children];
        const natural = Math.min(
          Number.parseFloat(style.maxWidth) || Infinity,
          inset +
            children.reduce(
              (sum, child) =>
                sum + Math.max(child.getBoundingClientRect().width, child.scrollWidth),
              0,
            ) +
            Math.max(0, children.length - 1) * (Number.parseFloat(style.columnGap) || 0),
        );
        return {
          natural,
          compact: button.classList.contains("model-trigger")
            ? Math.min(natural, 96)
            : Math.max(32, (children[0]?.getBoundingClientRect().width ?? 16) + inset),
          priority: settings.indexOf(button),
        };
      });
      fit();
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = new ResizeObserver(scheduleMeasure);
    const observe = () => {
      resize.disconnect();
      resize.observe(host);
      buttons().forEach((button) => {
        resize.observe(button);
        [...button.children].forEach((child) => resize.observe(child));
      });
      scheduleMeasure();
    };
    observe();
    const mutations = new MutationObserver(observe);
    mutations.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
    document.fonts.addEventListener("loadingdone", scheduleMeasure);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      document.fonts.removeEventListener("loadingdone", scheduleMeasure);
    };
  }, []);
  return (
    <div
      ref={root}
      className="composer-controls flex min-w-0 flex-1 items-center gap-2 overflow-visible data-[overflow=true]:overflow-x-auto data-[overflow=true]:[scrollbar-width:thin] @max-[560px]/composer:gap-1 [&_:focus-visible]:-outline-offset-2 [&>button]:shrink-0 [&_.composer-settings>div]:shrink-0 [&_.composer-settings>.contents>div]:shrink-0"
    >
      {children}
    </div>
  );
}
