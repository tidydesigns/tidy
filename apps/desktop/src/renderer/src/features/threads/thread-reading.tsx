import { createContext, useContext, useEffect } from "react";

/** Transcript activity is independent of whether its sidebar card is on screen. */
export const ThreadReadingContext = createContext(false);

/** Only the selected, loaded response subscribes, so activity changes do not redraw the list. */
export function ThreadReadMarker({
  visitKey,
  completionKey,
  onSeen,
}: {
  visitKey: string;
  completionKey: string;
  onSeen(value: string): void;
}) {
  const active = useContext(ThreadReadingContext);
  useEffect(() => {
    if (!active) return;
    const markSeen = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      onSeen(completionKey);
      try {
        localStorage.setItem(visitKey, completionKey);
      } catch {}
    };
    markSeen();
    document.addEventListener("visibilitychange", markSeen);
    window.addEventListener("focus", markSeen);
    return () => {
      document.removeEventListener("visibilitychange", markSeen);
      window.removeEventListener("focus", markSeen);
    };
  }, [active, visitKey, completionKey, onSeen]);
  return null;
}
