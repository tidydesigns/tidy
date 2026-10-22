import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { DocumentPreview } from "@tidy/editor/components/files/document-preview";
import { threadDesign } from "../../shared/thread-design";
import type { DesktopAPI, DesignSummary, LocalDesign, Thread } from "../../shared/contracts";
import { LocalCanvas } from "./local-canvas";

type Phase = "closed" | "opening" | "open" | "closing";
const easing = "cubic-bezier(0.32, 0.72, 0, 1)";

export function ThreadDesignWindow({
  api,
  thread,
  designs,
  active,
  onUpdate,
}: {
  api: DesktopAPI;
  thread: Thread;
  designs: DesignSummary[];
  active: boolean;
  onUpdate(design: LocalDesign): void;
}) {
  const candidate = threadDesign(thread, designs);
  // Keep the last window when the agent finishes, including an already expanded canvas.
  const [targetId, setTargetId] = useState<string>();
  const [value, setValue] = useState<LocalDesign>();
  const [phase, setPhase] = useState<Phase>("closed");
  const [visited, setVisited] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const animation = useRef<Animation | null>(null);
  const generation = useRef(0);
  const restoreFocus = useRef(false);
  const id = useId();
  const expanded = phase !== "closed";
  const summary = designs.find((design) => design.id === targetId);
  const update = useCallback(
    (design: LocalDesign) => {
      setValue(design);
      onUpdate(design);
    },
    [onUpdate],
  );

  useEffect(() => {
    // Do not replace the file under someone's pointer while they are inspecting it.
    if (thread.status === "running" && candidate && !expanded) setTargetId(candidate.id);
  }, [thread.status, candidate?.id, expanded]);

  useEffect(() => {
    if (!summary) return;
    let current = true;
    void api.readDesign(thread.projectId, summary.id).then(
      (design) => {
        if (current) setValue(design);
      },
      () => {
        // Atomic writes can briefly make a design unavailable. Keep its last valid frame.
      },
    );
    return () => {
      current = false;
    };
  }, [api, thread.projectId, summary?.id, summary?.updatedAt]);

  const closeImmediately = useCallback(() => {
    generation.current++;
    animation.current?.cancel();
    animation.current = null;
    dialog.current?.close();
    setPhase("closed");
  }, []);

  useEffect(() => {
    if (!active || !summary) closeImmediately();
  }, [active, summary?.id, closeImmediately]);
  useEffect(() => {
    if (phase === "open")
      dialog.current
        ?.querySelector<HTMLButtonElement>('[aria-label="Minimise canvas"]')
        ?.focus({ preventScroll: true });
    if (phase === "closed" && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus({ preventScroll: true });
    }
  }, [phase]);
  useEffect(
    () => () => {
      generation.current++;
      animation.current?.cancel();
    },
    [],
  );

  const transition = useCallback((open: boolean) => {
    const surface = dialog.current;
    const button = trigger.current;
    if (!surface || !button) return;
    const epoch = ++generation.current;
    const rect = button.getBoundingClientRect();
    const compact = `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / window.innerWidth}, ${rect.height / window.innerHeight})`;
    const radius = getComputedStyle(button).borderRadius;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const previous = surface.open
      ? {
          transform: getComputedStyle(surface).transform,
          borderRadius: getComputedStyle(surface).borderRadius,
        }
      : { transform: compact, borderRadius: radius };
    animation.current?.cancel();
    if (open && !surface.open) surface.showModal();
    setPhase(open ? "opening" : "closing");
    if (open) setVisited(true);
    const motion = surface.animate(
      [
        reduced ? { opacity: open ? 0 : 1 } : previous,
        reduced
          ? { opacity: open ? 1 : 0 }
          : { transform: open ? "none" : compact, borderRadius: open ? "0%" : radius },
      ],
      { duration: reduced ? 100 : 280, easing, fill: "both" },
    );
    animation.current = motion;
    void motion.finished.then(
      () => {
        if (generation.current !== epoch) return;
        if (open) {
          setPhase("open");
        } else {
          restoreFocus.current = true;
          surface.close();
          setPhase("closed");
        }
        motion.cancel();
        animation.current = null;
      },
      () => {},
    );
  }, []);
  const minimise = useCallback(() => transition(false), [transition]);

  if (!summary || !value || value.id !== summary.id) return null;
  return (
    <div className="thread-design-window" data-working={thread.status === "running"}>
      <Button
        ref={trigger}
        type="button"
        className="thread-design-peek"
        aria-label={`Expand ${value.name} canvas`}
        aria-haspopup="dialog"
        aria-controls={id}
        aria-expanded={expanded}
        data-expanded={expanded}
        onClick={() => transition(true)}
      >
        <span className="thread-design-artwork" aria-hidden="true" inert>
          <DocumentPreview content={value.document} assetUrl={(id) => value.assets[id] ?? ""} />
        </span>
        <span className="thread-design-expand" aria-hidden="true">
          ↗
        </span>
      </Button>
      <span className="thread-design-caption">{value.name}</span>
      <Dialog
        ref={dialog}
        id={id}
        padded={false}
        className="thread-design-dialog"
        aria-label={`${value.name} canvas`}
        data-phase={phase}
        onCancel={(event) => {
          event.preventDefault();
          transition(false);
        }}
        onClose={() => {
          if (dialog.current?.open) return;
          setPhase("closed");
        }}
      >
        <div className="thread-design-canvas" inert={phase !== "open"}>
          {visited && (
            <LocalCanvas
              key={value.id}
              api={api}
              projectId={thread.projectId}
              initial={value}
              active={phase === "open"}
              initialPanelsOpen={false}
              backLabel="Minimise canvas"
              onBack={minimise}
              onUpdate={update}
            />
          )}
        </div>
        <div className="thread-design-transition-artwork" aria-hidden="true" inert>
          <DocumentPreview content={value.document} assetUrl={(id) => value.assets[id] ?? ""} />
        </div>
      </Dialog>
    </div>
  );
}
