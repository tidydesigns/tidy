import { browserEditingCommand } from "./browser-keyboard";
import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
  type KeyboardEvent,
  type PointerEvent,
  type MouseEvent,
} from "react";
import {
  BROWSER_CLIPBOARD_LIMIT,
  type BrowserAPI,
  type BrowserScope,
  type BrowserState,
  type BrowserInput,
  type BrowserInputEnvelope,
} from "../../../../shared/contracts/browser";
const modifierBits = (event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export function BrowserPage({
  api,
  scope,
  tab,
  interactive,
  editingCommands,
  canvas,
  keyboard,
  addressInput,
  painted,
  copy,
  setError,
  send,
}: {
  api: BrowserAPI;
  scope: BrowserScope;
  tab: BrowserState["tabs"][number] | undefined;
  interactive: boolean;
  editingCommands: boolean;
  canvas: RefObject<HTMLCanvasElement | null>;
  keyboard: RefObject<HTMLTextAreaElement | null>;
  addressInput: RefObject<HTMLInputElement | null>;
  painted: boolean;
  copy(): Promise<void>;
  setError(message: string): void;
  send(input: BrowserInput): void;
}) {
  const composing = useRef(false);
  const forwardedKeys = useRef(new Set<string>());
  useEffect(() => forwardedKeys.current.clear(), [tab?.id, tab?.viewId, interactive]);
  useEffect(() => {
    const clear = () => forwardedKeys.current.clear();
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);
  const compositionView = useRef<Pick<BrowserInputEnvelope, "tabId" | "viewId"> | null>(null);
  const sendPage = useCallback(
    (input: Extract<BrowserInput, { kind: "mouse" | "wheel" | "key" | "text" }>) => {
      if (!interactive || !tab) return;
      api.input(scope, { tabId: tab.id, viewId: tab.viewId, input });
    },
    [api, scope.projectId, scope.threadId, tab?.id, tab?.viewId, interactive],
  );
  const insertText = (
    text: string,
    target = { tabId: tab?.id ?? null, viewId: tab?.viewId ?? null },
  ) => {
    if (!interactive || !target.tabId || !text) return;
    if (text.length > BROWSER_CLIPBOARD_LIMIT) {
      setError("Paste up to 512,000 characters at a time.");
      return;
    }
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 16000, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      api.input(scope, { ...target, input: { kind: "text", text: text.slice(start, end) } });
      start = end;
    }
  };
  const point = (clientX: number, clientY: number) => {
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds || !tab || !bounds.width || !bounds.height) return null;
    const scaleX = tab.width / bounds.width;
    const scaleY = tab.height / bounds.height;
    return {
      scaleX,
      scaleY,
      x: Math.max(0, Math.min(tab.width - 1, (clientX - bounds.left) * scaleX)),
      y: Math.max(0, Math.min(tab.height - 1, (clientY - bounds.top) * scaleY)),
    };
  };
  const move = useRef<BrowserInputEnvelope | null>(null);
  const moveFrame = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );
  const pointer = (
    event: PointerEvent<HTMLCanvasElement> | MouseEvent<HTMLCanvasElement>,
    action: "move" | "down" | "up",
  ) => {
    if (!interactive || ("isPrimary" in event && !event.isPrimary) || !tab) return;
    const position = point(event.clientX, event.clientY);
    if (!position) return;
    event.preventDefault();
    const input: BrowserInput = {
      kind: "mouse",
      action,
      x: position.x,
      y: position.y,
      button:
        action === "move"
          ? "none"
          : event.button === 2
            ? "right"
            : event.button === 1
              ? "middle"
              : "left",
      buttons: event.buttons,
      clickCount: Math.min(3, action === "move" ? 0 : Math.max(1, event.detail)),
      modifiers: modifierBits(event),
    };
    if (action === "move") {
      move.current = { tabId: tab.id, viewId: tab.viewId, input };
      if (moveFrame.current === undefined)
        moveFrame.current = requestAnimationFrame(() => {
          moveFrame.current = undefined;
          if (move.current) api.input(scope, move.current);
          move.current = null;
        });
    } else {
      if (move.current) {
        api.input(scope, move.current);
        move.current = null;
      }
      sendPage(input);
    }
  };

  useEffect(() => {
    const element = canvas.current;
    if (!element || !interactive || !tab) return;
    const wheel = (event: WheelEvent) => {
      const position = point(event.clientX, event.clientY);
      if (!position) return;
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tab.height : 1;
      sendPage({
        kind: "wheel",
        x: position.x,
        y: position.y,
        deltaX: Math.max(
          -10000,
          Math.min(
            10000,
            event.deltaX * multiplier * (event.deltaMode === 0 ? position.scaleX : 1),
          ),
        ),
        deltaY: Math.max(
          -10000,
          Math.min(
            10000,
            event.deltaY * multiplier * (event.deltaMode === 0 ? position.scaleY : 1),
          ),
        ),
        modifiers: modifierBits(event),
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [interactive, tab?.id, tab?.width, tab?.height, sendPage]);

  const key = (event: KeyboardEvent<HTMLTextAreaElement>, action: "down" | "up") => {
    if (!interactive) return;
    if (action === "up") {
      if (!forwardedKeys.current.delete(event.code)) return;
      event.preventDefault();
      sendPage({
        kind: "key",
        action,
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        text: "",
        modifiers: modifierBits(event),
      });
      return;
    }
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Dead" || event.getModifierState("AltGraph")) return;
    if (event.key === "F6") {
      event.preventDefault();
      addressInput.current?.focus();
      addressInput.current?.select();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copy();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
    const text =
      [...event.key].length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      (!event.altKey || navigator.platform.startsWith("Mac"))
        ? event.key
        : "";
    event.preventDefault();
    forwardedKeys.current.add(event.code);
    const command =
      editingCommands && navigator.platform.startsWith("Mac")
        ? browserEditingCommand(event)
        : undefined;
    sendPage({
      kind: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      text,
      ...(command ? { command } : {}),
      modifiers: modifierBits(event),
    });
  };

  return (
    <>
      <canvas
        ref={canvas}
        className="browser-canvas block w-full shrink-0 touch-none bg-white object-contain object-top"
        style={
          tab
            ? {
                aspectRatio: `${tab.width} / ${tab.height}`,
                width: `min(100cqw, ${tab.width}px, calc(100cqh * ${tab.width / tab.height}))`,
              }
            : undefined
        }
        aria-label={tab ? `Browser page: ${tab.title}` : "Browser page"}
        hidden={!tab || tab.url === "about:blank" || !painted}
        onPointerDown={(event) => {
          if (!interactive || !event.isPrimary) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          keyboard.current?.focus({ preventScroll: true });
          if (event.pointerType !== "mouse") pointer(event, "down");
        }}
        onMouseDown={(event) => pointer(event, "down")}
        onMouseUp={(event) => pointer(event, "up")}
        onPointerMove={(event) => pointer(event, "move")}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          if (event.pointerType !== "mouse") pointer(event, "up");
        }}
        onPointerCancel={() => {
          forwardedKeys.current.clear();
          send({ kind: "release-keys" });
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
      <textarea
        ref={keyboard}
        className="browser-keyboard absolute top-0 left-0 size-px resize-none border-0 p-0 opacity-0"
        aria-label="Type into browser page"
        aria-description="Press F6 to focus the address bar."
        tabIndex={interactive ? 0 : -1}
        disabled={!interactive}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(event) => key(event, "down")}
        onKeyUp={(event) => key(event, "up")}
        onBlur={() => {
          forwardedKeys.current.clear();
          send({ kind: "release-keys" });
        }}
        onCompositionStart={() => {
          forwardedKeys.current.clear();
          send({ kind: "release-keys" });
          composing.current = true;
          compositionView.current = tab ? { tabId: tab.id, viewId: tab.viewId } : null;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          const target = compositionView.current;
          compositionView.current = null;
          if (target) insertText(event.currentTarget.value, target);
          event.currentTarget.value = "";
        }}
        onInput={(event) => {
          if (composing.current) return;
          insertText(event.currentTarget.value);
          event.currentTarget.value = "";
        }}
        onPaste={(event) => {
          event.preventDefault();
          insertText(event.clipboardData.getData("text/plain"));
        }}
      />
    </>
  );
}
