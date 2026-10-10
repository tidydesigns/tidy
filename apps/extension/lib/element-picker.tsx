import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button } from "@tidy/ui/button";
import instrumentSans from "../public/fonts/InstrumentSans-Latin.woff2?inline";

export const MAX_SELECTED_ELEMENTS = 20;

function contains(ancestor: Element, element: Element) {
  for (let current: Element | null = element; current;) {
    if (current === ancestor) return true;
    const root = current.getRootNode();
    current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

export function startElementPicker({
  theme,
  onConfirm,
  onCancel,
}: {
  theme?: unknown;
  onConfirm: (elements: Element[]) => void;
  onCancel: () => void;
}) {
  const host = document.createElement("div");
  host.dataset.bellaPicker = "";
  host.style.cssText =
    "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host{--ink:light-dark(#424242,#d0d0d0);--muted:light-dark(#646464,#b7b7b7);--panel:light-dark(#fafafa,#202020);--border:light-dark(#dedede,#3a3a3a);--action:light-dark(#424242,#343434)}
    *{box-sizing:border-box}
    .outline{position:fixed;pointer-events:none;border:1px solid var(--ink);background:light-dark(#4242420a,#d0d0d00a)}
    .selected{border:2px solid var(--ink);background:light-dark(#42424214,#d0d0d014)}
    .toolbar{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:16px;width:max-content;max-width:calc(100vw - 32px);padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--ink);box-shadow:0 2px 12px #0002;pointer-events:auto;font:15px/1.4 "Tidy Instrument Sans",system-ui,sans-serif}
    .hint{color:var(--muted);font-size:13px}
    button{flex-shrink:0;min-height:36px;border:1px solid var(--action);border-radius:6px;padding:8px 12px;background:var(--action);color:#fff;font:inherit;font-weight:500;cursor:pointer}
    button:disabled{opacity:.5;cursor:default}
    button:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
    button:active:enabled{background:light-dark(#595959,#444444)}
    @media(hover:hover) and (pointer:fine){button:hover:enabled{background:light-dark(#595959,#444444)}}
    @media(max-width:620px){.toolbar{flex-wrap:wrap;gap:8px}.hint{flex-basis:100%}}
  `;
  const outline = document.createElement("div");
  outline.className = "outline";
  outline.hidden = true;
  const selections = document.createElement("div");
  const toolbar = document.createElement("div");
  shadow.append(style, outline, selections, toolbar);
  document.documentElement.append(host);
  const root = createRoot(toolbar);
  let font: FontFace | undefined;
  if (typeof FontFace !== "undefined" && instrumentSans.startsWith("data:")) {
    const bytes = Uint8Array.from(atob(instrumentSans.split(",")[1]!), (character) =>
      character.charCodeAt(0),
    );
    font = new FontFace("Tidy Instrument Sans", bytes.buffer, { weight: "400 700" });
    document.fonts.add(font);
    void font.load().catch(() => undefined);
  }
  let target: Element | undefined;
  let selected: Element[] = [];
  let stopped = false;
  let notice = "";
  const setTheme = (value: unknown) => {
    host.style.setProperty(
      "color-scheme",
      value === "dark" || value === "light" ? value : "light dark",
      "important",
    );
  };
  setTheme(theme);
  function confirm() {
    if (stopped || !selected.length) return;
    if (selected.some((element) => !element.isConnected)) {
      notice = "An element disappeared. Select it again.";
      selected = selected.filter((element) => element.isConnected);
      render();
      return;
    }
    const elements = [...selected];
    stop();
    onConfirm(elements);
  }
  function position(element: HTMLElement, target: Element) {
    const box = target.getBoundingClientRect();
    Object.assign(element.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
  }
  function highlight() {
    outline.hidden = !target?.isConnected;
    if (target?.isConnected) position(outline, target);
    selections.replaceChildren(
      ...selected
        .filter((element) => element.isConnected)
        .map((element) => {
          const box = document.createElement("div");
          box.className = "outline selected";
          position(box, element);
          return box;
        }),
    );
  }
  function render() {
    highlight();
    flushSync(() =>
      root.render(
        <div className="toolbar">
          <span className="hint" role="status">
            {notice || "Click to select · ↑ parent · ↓ child · Esc cancel"}
          </span>
          <Button
            disabled={!selected.length}
            onClick={confirm}
            title="Copy selected elements · Enter"
          >
            {selected.length > 1
              ? `Copy ${selected.length} elements`
              : selected.length
                ? "Copy element"
                : "Copy elements"}
          </Button>
        </div>,
      ),
    );
  }
  const inToolbar = (event: Event) => event.composedPath().includes(host);
  const suppress = (event: Event) => {
    if (inToolbar(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const move = (event: PointerEvent) => {
    if (inToolbar(event)) return;
    target = event.composedPath().find((node) => node instanceof Element) as Element | undefined;
    highlight();
  };
  const click = (event: MouseEvent) => {
    if (inToolbar(event)) return;
    suppress(event);
    if (!target?.isConnected) return;
    notice = "";
    const prior = selected.find((element) => contains(element, target!));
    if (prior) selected = selected.filter((element) => element !== prior);
    else {
      const next = selected.filter((element) => !contains(target!, element));
      if (next.length >= MAX_SELECTED_ELEMENTS)
        notice = `Select up to ${MAX_SELECTED_ELEMENTS} elements at a time.`;
      else selected = [...next, target];
    }
    render();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
      onCancel();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (inToolbar(event)) return;
      suppress(event);
      target =
        (event.key === "ArrowUp" ? target?.parentElement : target?.firstElementChild) ?? target;
      highlight();
    } else if (event.key === "Enter" && !inToolbar(event)) {
      suppress(event);
      confirm();
    }
  };
  function stop() {
    if (stopped) return;
    stopped = true;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerdown", suppress, true);
    window.removeEventListener("pointerup", suppress, true);
    window.removeEventListener("click", click, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("scroll", highlight, true);
    window.removeEventListener("resize", highlight);
    root.unmount();
    host.remove();
    if (font) document.fonts.delete(font);
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerdown", suppress, true);
  window.addEventListener("pointerup", suppress, true);
  window.addEventListener("click", click, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("scroll", highlight, true);
  window.addEventListener("resize", highlight);
  render();
  return { stop, setTheme };
}
