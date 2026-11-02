import { useLayoutEffect, useState, type RefObject } from "react";

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useLayoutEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function usePanelDialog(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  modal: boolean,
) {
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const focused = dialog.contains(document.activeElement) ? document.activeElement : null;
    if (dialog.open && (!open || dialog.matches(":modal") !== modal)) dialog.close();
    if (!open) return;
    if (!dialog.open) {
      if (modal) dialog.showModal();
      else dialog.show();
      if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    }
  }, [ref, open, modal]);
}
