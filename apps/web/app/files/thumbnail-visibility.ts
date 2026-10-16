let observer: IntersectionObserver | undefined;
let viewportObserver: IntersectionObserver | undefined;
const listeners = new Map<
  Element,
  { notify: (near: boolean, visible: boolean) => void; near: boolean; visible: boolean }
>();
export function observeThumbnail(
  element: Element,
  notify: (near: boolean, visible: boolean) => void,
) {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const listener = listeners.get(entry.target);
        if (!listener) continue;
        listener.near = entry.isIntersecting;
        listener.notify(listener.near, listener.visible);
      }
    },
    { rootMargin: "200px" },
  );
  viewportObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const listener = listeners.get(entry.target);
      if (!listener) continue;
      listener.visible = entry.isIntersecting;
      // Entering the viewport also implies proximity, regardless of callback order.
      listener.notify(listener.near || listener.visible, listener.visible);
    }
  });
  listeners.set(element, { notify, near: false, visible: false });
  observer.observe(element);
  viewportObserver.observe(element);
  return () => {
    observer?.unobserve(element);
    viewportObserver?.unobserve(element);
    listeners.delete(element);
    if (!listeners.size) {
      observer?.disconnect();
      viewportObserver?.disconnect();
      observer = undefined;
      viewportObserver = undefined;
    }
  };
}
