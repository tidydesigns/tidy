import { useState, type CSSProperties, type ReactNode } from "react";

// Keep visited panels mounted so closing can finish and reopening retains scroll state.
export function EditorPanel({
  open,
  width,
  side = "left",
  children,
}: {
  open: boolean;
  width: number;
  side?: "left" | "right";
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(open);
  const [animateEnter] = useState(!open);
  if (open && !visited) setVisited(true);
  if (!open && !visited) return null;

  return (
    <div
      className="editor-panel"
      data-open={open}
      data-side={side}
      data-animate-enter={animateEnter}
      aria-hidden={!open || undefined}
      inert={!open}
      style={{ "--editor-panel-width": `${width}px` } as CSSProperties}
    >
      {children}
    </div>
  );
}

// CSS handles the handoff without timers that could race a subsequent toggle.
export function EditorChrome({ visible, children }: { visible: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(visible);
  const [animateEnter] = useState(!visible);
  if (visible && !visited) setVisited(true);
  if (!visible && !visited) return null;

  return (
    <div
      className="editor-compact-chrome"
      data-visible={visible}
      data-animate-enter={animateEnter}
      aria-hidden={!visible || undefined}
      inert={!visible}
    >
      {children}
    </div>
  );
}
