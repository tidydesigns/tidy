let observer: IntersectionObserver | undefined;
const listeners = new Map<Element, (visible: boolean) => void>();
export function observeThumbnail(element: Element, notify: (visible: boolean) => void) {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
    },
    { rootMargin: "200px" },
  );
  listeners.set(element, notify);
  observer.observe(element);
  return () => {
    observer?.unobserve(element);
    listeners.delete(element);
    if (!listeners.size) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}
