import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Track viewport breakpoints as they change without remounting the panel. */
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

/** Open inline panels without autofocus and return panel focus to the opener on close. */
export function usePanelDialog(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  modal: boolean,
) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const focused = dialog.contains(document.activeElement) ? document.activeElement : null;
    if (dialog.open && (!open || dialog.matches(":modal") !== modal)) dialog.close();
    if (!open) {
      if (focused && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      opener.current = null;
      return;
    }
    if (!dialog.open) {
      const active = document.activeElement;
      if (!opener.current && active instanceof HTMLElement && active !== document.body && !focused)
        opener.current = active;
      if (modal) dialog.showModal();
      // Inline panels are layout, not focus destinations. show() would focus
      // their first control even on initial mount or a background refresh.
      else dialog.open = true;
      if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    }
  }, [ref, open, modal]);
}
