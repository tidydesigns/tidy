import { useLayoutEffect, useRef } from "react";

type Departure = {
  threadId: string;
  top: number;
  artwork: { element: HTMLElement; opacity: string }[];
};

export function useNewThreadTransition(selectionKey: string, threadId: string | null | undefined) {
  const composer = useRef<HTMLFormElement>(null);
  const departure = useRef<Departure | null>(null);

  useLayoutEffect(() => {
    const pending = departure.current;
    departure.current = null;
    if (!pending) return;
    const artwork = pending.artwork;
    const animations: Animation[] = [];
    if (pending.threadId === threadId && composer.current) {
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const offset = pending.top - composer.current.getBoundingClientRect().top;
      if (!reduced && offset) {
        animations.push(
          composer.current.animate(
            [
              { transform: `translate3d(0, ${offset}px, 0)` },
              { transform: "translate3d(0, 0, 0)" },
            ],
            { duration: 260, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
          ),
        );
      }
      for (const { element, opacity } of artwork) {
        const fade = element.animate([{ opacity }, { opacity: 0 }], {
          duration: reduced ? 120 : 180,
          easing: "cubic-bezier(0.23, 1, 0.32, 1)",
          fill: "forwards",
        });
        fade.onfinish = () => element.remove();
        animations.push(fade);
      }
    } else {
      for (const { element } of artwork) element.remove();
    }
    return () => {
      for (const animation of animations) animation.cancel();
      for (const { element } of artwork) element.remove();
    };
  }, [selectionKey, threadId]);

  function begin(nextThreadId: string) {
    const form = composer.current;
    const workspace = form?.closest<HTMLElement>(".thread-workspace");
    if (!form || !workspace || threadId) return;
    const top = form.getBoundingClientRect().top;
    const bounds = workspace.getBoundingClientRect();
    const measurements = Array.from(
      workspace.querySelectorAll<HTMLElement>("[data-thread-branding], [data-thread-atmosphere]"),
      (element) => ({
        element,
        rect: element.getBoundingClientRect(),
        opacity: getComputedStyle(element).opacity,
      }),
    );
    const artwork = measurements.flatMap(({ element, rect, opacity }) => {
      const copy = element.cloneNode(true);
      if (!(copy instanceof HTMLElement)) return [];
      copy.removeAttribute("data-thread-branding");
      copy.removeAttribute("data-thread-atmosphere");
      Object.assign(copy.style, {
        position: "absolute",
        top: `${rect.top - bounds.top}px`,
        left: `${rect.left - bounds.left}px`,
        bottom: "auto",
        right: "auto",
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        transform: "none",
        translate: "none",
      });
      return [{ element: copy, opacity }];
    });
    workspace.append(...artwork.map(({ element }) => element));
    departure.current = { threadId: nextThreadId, top, artwork };
  }

  return { composer, begin };
}
