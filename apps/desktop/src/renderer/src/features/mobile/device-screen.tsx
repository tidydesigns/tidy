import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { MobileAPI, MobileInput } from "../../../../shared/contracts/mobile";

/** Scale pointer coordinates against the displayed content, including letterboxing. */
export function devicePoint(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
) {
  return {
    x: Math.min(1, Math.max(0, (x - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (y - rect.top) / rect.height)),
  };
}

export function DeviceScreen({
  api,
  projectId,
  sessionId,
  active,
  name,
  onError,
}: {
  api: MobileAPI;
  projectId: string;
  sessionId: string;
  active: boolean;
  name: string;
  onError(message: string): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyboardInput = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 390, height: 844 });
  const [visible, setVisible] = useState(!document.hidden);
  const touch = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const error = useRef(onError);
  error.current = onError;
  const queue = useRef<MobileInput["event"][]>([]);
  const sending = useRef(false);
  const generation = useRef(0);
  const enabled = active && visible;
  const isEnabled = useRef(enabled);
  isEnabled.current = enabled;
  const send = (event: MobileInput["event"]) => {
    if (!isEnabled.current) return;
    const previous = queue.current.at(-1);
    if (
      event.kind === "touch" &&
      event.phase === "move" &&
      previous?.kind === "touch" &&
      previous.phase === "move"
    )
      queue.current[queue.current.length - 1] = event;
    else if (queue.current.length < 64) queue.current.push(event);
    if (sending.current) return;
    sending.current = true;
    const current = generation.current;
    void (async () => {
      try {
        while (queue.current.length && current === generation.current) {
          const next = queue.current.shift()!;
          await api.input({ projectId, sessionId, event: next });
        }
      } catch (cause) {
        queue.current = [];
        if (current === generation.current)
          error.current(cause instanceof Error ? cause.message : "Device input failed.");
      } finally {
        sending.current = false;
      }
    })();
  };
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let sequence = 0;
    let retry: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        while (!cancelled) {
          const frame = await api.frame({ projectId, sessionId, after: sequence });
          if (cancelled) return;
          if (!frame) {
            await new Promise<void>((resolve) => {
              retry = setTimeout(resolve, 40);
            });
            continue;
          }
          sequence = frame.sequence;
          const binary = atob(frame.data);
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: frame.mime }));
          try {
            if (cancelled || !canvas.current) return;
            const node = canvas.current;
            const rotated = frame.rotation === 90 || frame.rotation === 270;
            const width = rotated ? bitmap.height : bitmap.width,
              height = rotated ? bitmap.width : bitmap.height;
            if (node.width !== width || node.height !== height) {
              node.width = width;
              node.height = height;
            }
            const context = node.getContext("2d", { alpha: false });
            if (context) {
              context.save();
              context.translate(width / 2, height / 2);
              context.rotate(((frame.rotation ?? 0) * Math.PI) / 180);
              context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
              context.restore();
            }
            setDimensions((current) =>
              current.width === width && current.height === height ? current : { width, height },
            );
            setReady(true);
          } finally {
            bitmap.close();
          }
        }
      } catch (cause) {
        if (!cancelled)
          error.current(cause instanceof Error ? cause.message : "Device display disconnected.");
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [api, projectId, sessionId, enabled]);
  useEffect(
    () => () => {
      generation.current++;
      queue.current = [];
      const current = touch.current;
      if (current)
        void api
          .input({
            projectId,
            sessionId,
            event: { kind: "touch", phase: "up", x: current.x, y: current.y },
          })
          .catch(() => {});
      touch.current = null;
    },
    [api, projectId, sessionId, enabled],
  );
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const resize = () => {
      const width = Math.max(1, node.clientWidth - 48),
        height = Math.max(1, node.clientHeight - 40);
      const scale = Math.min(width / dimensions.width, height / dimensions.height);
      const screen = canvas.current;
      if (screen) {
        screen.style.width = `${Math.floor(dimensions.width * scale)}px`;
        screen.style.height = `${Math.floor(dimensions.height * scale)}px`;
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, [dimensions]);
  const pointer = (event: PointerEvent<HTMLCanvasElement>, phase: "down" | "move" | "up") => {
    if (!enabled || !ready) return;
    if (phase === "down") {
      if (touch.current || !event.isPrimary || event.button !== 0) return;
      keyboardInput.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (touch.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = devicePoint(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    );
    touch.current = phase === "up" ? null : { pointerId: event.pointerId, ...point };
    send({ kind: "touch", phase, ...point });
    if (phase === "up" && event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyboard = (event: KeyboardEvent<HTMLCanvasElement | HTMLTextAreaElement>) => {
    if (
      !enabled ||
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.key === "Tab"
    )
      return;
    if (
      event.key.length === 1 ||
      [
        "Enter",
        "Backspace",
        "Delete",
        "Escape",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
      ].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      send({ kind: "key", code: event.code, shift: event.shiftKey });
    }
  };
  return (
    <div ref={container} className="device-stage" data-ready={ready || undefined}>
      {!ready && (
        <span className="device-connecting" role="status">
          Connecting display…
        </span>
      )}
      <canvas
        ref={canvas}
        className="device-screen"
        aria-label={`${name} interactive screen`}
        aria-description="Click to tap, drag to swipe, and type to enter text. Paste inserts clipboard text. Tab returns to Tidy controls."
        role="application"
        tabIndex={enabled && ready ? 0 : -1}
        onFocus={() => keyboardInput.current?.focus({ preventScroll: true })}
        onPointerDown={(event) => pointer(event, "down")}
        onPointerMove={(event) => pointer(event, "move")}
        onPointerUp={(event) => pointer(event, "up")}
        onPointerCancel={(event) => pointer(event, "up")}
        onLostPointerCapture={(event) => {
          if (touch.current?.pointerId !== event.pointerId) return;
          const point = touch.current;
          touch.current = null;
          send({ kind: "touch", phase: "up", x: point.x, y: point.y });
        }}
        onBlur={() => {
          const point = touch.current;
          if (point) {
            touch.current = null;
            send({ kind: "touch", phase: "up", x: point.x, y: point.y });
          }
        }}
        onKeyDown={keyboard}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain");
          if (text && enabled) {
            event.preventDefault();
            event.stopPropagation();
            send({ kind: "text", text: text.slice(0, 4096) });
          }
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
      <textarea
        ref={keyboardInput}
        className="device-keyboard-input"
        aria-label={`${name} keyboard input`}
        aria-description="Type or paste into the focused field on the device. Tab returns to Tidy controls."
        tabIndex={-1}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={keyboard}
        onInput={(event) => {
          if (composing.current) return;
          const text = event.currentTarget.value;
          event.currentTarget.value = "";
          if (text) send({ kind: "text", text: text.slice(0, 4096) });
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          const text = event.currentTarget.value;
          event.currentTarget.value = "";
          if (text) send({ kind: "text", text: text.slice(0, 4096) });
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain");
          if (text && enabled) {
            event.preventDefault();
            event.stopPropagation();
            send({ kind: "text", text: text.slice(0, 4096) });
          }
        }}
        onBlur={() => {
          const point = touch.current;
          if (point) {
            touch.current = null;
            send({ kind: "touch", phase: "up", x: point.x, y: point.y });
          }
        }}
      />
    </div>
  );
}
