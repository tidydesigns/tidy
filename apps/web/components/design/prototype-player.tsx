"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { TidyDesign } from "@tidy/design-renderer/design";
import { resolvedDocumentNodes } from "@bella/design/design-tokens";
import {
  playInteraction,
  prototypeFrameNodes,
  prototypeInteractions,
  startPrototype,
} from "@bella/design/prototype";
import { documentAssetIds, nodePageId, type DesignDocument } from "@/lib/design/document";
import { useDocumentFonts } from "@/lib/design/fonts/use-document-fonts";
import { SelectMenu } from "@/components/ui/select-menu";

const button =
  "rounded-md border border-primary-grey/70 px-3 py-1.5 text-xs hover:bg-primary-grey/20 disabled:opacity-40";
export function PrototypePlayer({
  document,
  revision,
  fileName,
  initialFrameId,
  presentationHref,
  onExit,
}: {
  document: DesignDocument;
  revision: number;
  fileName: string;
  initialFrameId?: string;
  presentationHref?: string;
  onExit?: () => void;
}) {
  const frames = resolvedDocumentNodes(document).filter(
    (node) => node.type === "artboard" && node.visible,
  );
  const first = frames.find((node) => node.id === initialFrameId)?.id ?? frames[0]?.id ?? "";
  const [session, setSession] = useState(() => startPrototype(first));
  const [message, setMessage] = useState("");
  const [width, setWidth] = useState(1);
  const stage = useRef<HTMLDivElement>(null),
    screen = useRef<HTMLDivElement>(null),
    overlayPanel = useRef<HTMLDivElement>(null);
  const current = frames.find((node) => node.id === session.frameId) ?? frames[0];
  const overlay = session.overlays.at(-1);
  const overlayFrame = frames.find((node) => node.id === overlay?.frameId);
  const rendered = useMemo(
    () => resolvedDocumentNodes(document, new Map(Object.entries(session.variants))),
    [document, session.variants],
  );
  const played = useMemo(() => ({ ...document, nodes: rendered }), [document, rendered]);
  const activeFrame = overlayFrame ?? current;
  const visibleNodes = prototypeFrameNodes(played, activeFrame?.id ?? "");
  useDocumentFonts(rendered);
  const assets = useMemo(
    () =>
      Object.fromEntries(
        documentAssetIds(document).map((id) => [id, `/api/assets/${encodeURIComponent(id)}`]),
      ),
    [document],
  );
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  function trigger(id: string, type: "click" | "hover" | "key", key?: string) {
    const node = visibleNodes.find((node) => node.id === id);
    if (!node || node.semantics?.disabled || session.states[id] === "disabled") return false;
    const interactions = prototypeInteractions(node, type, key);
    if (!interactions.length) return false;
    setSession((current) => interactions.reduce(playInteraction, current));
    return true;
  }
  const timed = visibleNodes.flatMap((node) =>
    (node.interactions ?? []).flatMap((interaction) =>
      interaction.trigger.type === "afterDelay" &&
      !node.semantics?.disabled &&
      session.states[node.id] !== "disabled"
        ? [{ nodeId: node.id, interaction, delay: interaction.trigger.delay }]
        : [],
    ),
  );
  const timersKey = JSON.stringify(timed);
  const fired = useRef(new Set<string>());
  useEffect(() => {
    const items = JSON.parse(timersKey) as typeof timed;
    const timers = items.map(({ nodeId, interaction, delay }) => {
      const id = `${revision}:${session.entry}:${nodeId}:${interaction.id}`;
      if (fired.current.has(id)) return undefined;
      return window.setTimeout(() => {
        fired.current.add(id);
        setSession((current) =>
          current.entry === session.entry ? playInteraction(current, interaction) : current,
        );
      }, delay);
    });
    return () => {
      for (const timer of timers) if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [timersKey, session.entry, revision]);
  useEffect(() => {
    const element = overlayPanel.current ?? screen.current;
    if (!element) return;
    const focus =
      element.querySelector<HTMLElement>('button:not(:disabled), a, [tabindex="0"]') ?? element;
    focus.focus({ preventScroll: true });
  }, [session.entry]);
  useEffect(() => {
    const element = overlayPanel.current ?? screen.current;
    if (!element) return;
    if (
      session.transition.type === "instant" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const animation = element.animate(
      session.transition.type === "fade"
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { transform: "translateX(32px)", opacity: 0 },
            { transform: "translateX(0)", opacity: 1 },
          ],
      { duration: session.transition.duration, easing: "ease-out" },
    );
    return () => animation.cancel();
  }, [session.entry, session.transition]);
  function back() {
    setSession((current) =>
      playInteraction(current, {
        id: "back",
        trigger: { type: "click" },
        action: { type: "back" },
        transition: { type: "instant", duration: 0 },
      }),
    );
  }
  function restart() {
    fired.current.clear();
    setSession((current) => ({ ...startPrototype(first), entry: current.entry + 1 }));
  }
  function frame(id: string) {
    fired.current.clear();
    setSession((current) => ({ ...startPrototype(id), entry: current.entry + 1 }));
  }
  function render(frame: NonNullable<typeof current>) {
    const scale = Math.min(1, Math.max(1, width - 32) / frame.box.width);
    return (
      <div style={{ width: frame.box.width * scale, height: frame.box.height * scale }}>
        <div
          style={{
            width: frame.box.width,
            height: frame.box.height,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          <TidyDesign
            document={played}
            rootId={frame.id}
            assets={assets}
            states={session.states}
            onTrigger={trigger}
            frameWidth={frame.box.width}
          />
        </div>
      </div>
    );
  }
  return (
    <section
      aria-label="Prototype player"
      className="flex h-full min-h-0 flex-col bg-canvas text-primary-black"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          if (overlay) back();
          else onExit?.();
        }
        if (event.altKey && event.key === "ArrowLeft") {
          event.preventDefault();
          back();
        }
        if (overlay && event.key === "Tab" && overlayPanel.current) {
          const items = [
            ...overlayPanel.current.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], [tabindex="0"]',
            ),
          ];
          const first = items[0],
            last = items.at(-1);
          if (!first) {
            event.preventDefault();
            overlayPanel.current.focus();
          } else if (
            event.shiftKey &&
            (globalThis.document.activeElement === first ||
              globalThis.document.activeElement === overlayPanel.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && globalThis.document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <header
        inert={Boolean(overlay)}
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-primary-grey/70 bg-surface p-3"
      >
        {onExit && (
          <button className={button} onClick={onExit}>
            Exit preview
          </button>
        )}
        <button className={button} disabled={!session.history.length && !overlay} onClick={back}>
          Back
        </button>
        <button className={button} onClick={restart}>
          Restart
        </button>
        {!!frames.length && (
          <SelectMenu
            label="Presentation frame"
            size="sm"
            value={current?.id ?? ""}
            onChange={frame}
            options={frames.map((node) => ({
              value: node.id,
              label: `${document.pages.find((page) => page.id === nodePageId(node))?.name ?? "Page"} · ${node.name}`,
            }))}
          />
        )}
        <span className="min-w-0 truncate text-xs text-secondary-ink">
          {fileName} · r{revision}
        </span>
        {presentationHref && (
          <button
            className={button}
            onClick={() =>
              void navigator.clipboard
                .writeText(
                  new URL(
                    `${presentationHref}?frame=${encodeURIComponent(current?.id ?? "")}`,
                    window.location.origin,
                  ).href,
                )
                .then(
                  () => setMessage("Presentation link copied. File membership is required."),
                  () => setMessage("Could not copy the presentation link."),
                )
            }
          >
            Copy presentation link
          </button>
        )}
      </header>
      <div
        ref={stage}
        className="relative min-h-0 flex-1 overflow-auto p-4"
        onErrorCapture={() => setMessage("One or more prototype images could not be loaded.")}
      >
        {current ? (
          <div
            ref={screen}
            tabIndex={-1}
            inert={Boolean(overlay)}
            aria-label={`Screen ${current.name}`}
            className="mx-auto w-fit outline-none"
          >
            {render(current)}
          </div>
        ) : (
          <p className="text-sm">This prototype has no visible frames.</p>
        )}
        {overlayFrame && overlay && (
          <div
            className={`absolute inset-0 z-10 flex bg-black/30 p-4 ${overlay.position === "top" ? "items-start" : overlay.position === "bottom" ? "items-end" : "items-center"} justify-center`}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (event.target === event.currentTarget && overlay.dismissOutside) back();
            }}
          >
            <div
              ref={overlayPanel}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label={overlayFrame.name}
              className="max-h-full overflow-auto outline-none"
            >
              <button className={`${button} mb-2 bg-surface`} onClick={back}>
                Close overlay
              </button>
              {render(overlayFrame)}
            </div>
          </div>
        )}
      </div>
      {message && (
        <p role="status" className="shrink-0 bg-surface px-3 py-2 text-xs">
          {message}
        </p>
      )}
    </section>
  );
}
