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
  let previousFocus = document.activeElement as HTMLElement | null;
  while (previousFocus?.shadowRoot?.activeElement)
    previousFocus = previousFocus.shadowRoot.activeElement as HTMLElement;
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
    .toolbar{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 32px);padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--ink);box-shadow:0 2px 12px #0002;pointer-events:auto;font:15px/1.4 "Tidy Instrument Sans",system-ui,sans-serif}
    .selection-row{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
    .target{max-width:min(320px,calc(100vw - 64px));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .target[aria-pressed=true]{outline:2px solid var(--ink);outline-offset:2px}
    .hint{color:var(--muted);font-size:14px}
    .shortcuts{margin-top:8px;color:var(--muted);font-size:12px}
    summary{width:max-content;cursor:pointer}
    summary:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-radius:2px}
    .shortcut-list{display:grid;grid-template-columns:1fr auto;gap:8px 24px;margin:12px 0 0;padding-top:12px;border-top:1px solid var(--border);font-size:13px}
    .shortcut-list dt,.shortcut-list dd{margin:0}
    kbd{display:inline-block;min-width:28px;padding:1px 6px;border:1px solid var(--border);border-radius:4px;color:var(--ink);font:inherit;text-align:center}
    button{flex-shrink:0;min-height:36px;border:1px solid var(--action);border-radius:6px;padding:8px 12px;background:var(--action);color:#fff;font:inherit;font-weight:500;cursor:pointer}
    button:disabled{opacity:.5;cursor:default}
    button:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
    button:active:enabled{background:light-dark(#595959,#444444)}
    @media(hover:hover) and (pointer:fine){button:hover:enabled{background:light-dark(#595959,#444444)}}
    @media(max-width:440px){.selection-row{flex-wrap:wrap;gap:12px}.hint{flex-basis:100%}}
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
  function parentElement(element: Element) {
    const tree = element.getRootNode();
    return element.parentElement ?? (tree instanceof ShadowRoot ? tree.host : undefined);
  }
  function children(element: Element) {
    return [...element.children, ...(element.shadowRoot?.children ?? [])];
  }
  function selectable(element: Element) {
    if (
      element === host ||
      element === document.documentElement ||
      /^(script|style|noscript|template|meta|link|title)$/i.test(element.localName)
    )
      return false;
    const box = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    return (
      box.width > 0 &&
      box.height > 0 &&
      computed.visibility !== "hidden" &&
      computed.visibility !== "collapse"
    );
  }
  function findTarget(elements: Element[], reverse = false): Element | undefined {
    for (const element of reverse ? elements.toReversed() : elements) {
      if (element === host) continue;
      if (selectable(element)) return element;
      const descendant = findTarget(children(element), reverse);
      if (descendant) return descendant;
    }
  }
  function description(element: Element) {
    const label =
      element.getAttribute("aria-label") ||
      element.getAttribute("alt") ||
      element.textContent ||
      "";
    const text = label.replace(/\s+/g, " ").trim().slice(0, 80);
    return `${element.localName}${text ? `: ${text}` : ""}`;
  }
  target =
    previousFocus && previousFocus !== document.body && selectable(previousFocus)
      ? previousFocus
      : findTarget([...document.body.children]);
  function toggleTarget() {
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
  }
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
          <div className="selection-row">
            <Button
              className="target"
              data-picker-target
              aria-pressed={!!target && selected.some((element) => contains(element, target!))}
              aria-describedby="picker-status picker-instructions"
              onClick={toggleTarget}
            >
              {target ? `Select ${description(target)}` : "No selectable elements"}
            </Button>
            <Button
              disabled={!selected.length}
              onClick={confirm}
              title="Copy selected elements (Enter)"
            >
              {selected.length > 1
                ? `Copy ${selected.length} elements`
                : selected.length
                  ? "Copy element"
                  : "Copy elements"}
            </Button>
          </div>
          <p className="hint" id="picker-status" role="status" aria-atomic="true">
            {notice ||
              `${selected.length} ${selected.length === 1 ? "element" : "elements"} selected.`}
          </p>
          <p className="hint" id="picker-instructions">
            Click page elements, or use arrows to browse and Space to select.
          </p>
          <details className="shortcuts">
            <summary>Keyboard shortcuts</summary>
            <dl className="shortcut-list">
              <dt>Select parent</dt>
              <dd>
                <kbd>↑</kbd>
              </dd>
              <dt>Select child</dt>
              <dd>
                <kbd>↓</kbd>
              </dd>
              <dt>Previous / next element</dt>
              <dd>
                <kbd>←</kbd> <kbd>→</kbd>
              </dd>
              <dt>Select / deselect element</dt>
              <dd>
                <kbd>Space</kbd>
              </dd>
              <dt>Copy selection</dt>
              <dd>
                Tab to Copy, then <kbd>Enter</kbd>
              </dd>
              <dt>Cancel</dt>
              <dd>
                <kbd>Esc</kbd>
              </dd>
            </dl>
          </details>
        </div>,
      ),
    );
  }
  const inToolbar = (event: Event) => event.composedPath().includes(host);
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const suppress = (event: Event) => {
    if (!inToolbar(event)) consume(event);
  };
  const pageTarget = (event: Event) =>
    event
      .composedPath()
      .find((node): node is Element => node instanceof Element && selectable(node));
  const move = (event: PointerEvent) => {
    if (inToolbar(event)) return;
    const next = pageTarget(event);
    if (!next || next === target) return;
    target = next;
    render();
  };
  const click = (event: MouseEvent) => {
    if (inToolbar(event)) return;
    suppress(event);
    const next = pageTarget(event);
    if (!next) return;
    target = next;
    toggleTarget();
    (shadow.querySelector("[data-picker-target]") as HTMLElement | null)?.focus();
  };
  function browse(direction: string) {
    if (!target?.isConnected) target = findTarget([...document.body.children]);
    else if (direction === "ArrowDown") target = findTarget(children(target)) ?? target;
    else if (direction === "ArrowUp") {
      let parent = parentElement(target);
      while (parent && !selectable(parent)) parent = parentElement(parent);
      target = parent ?? target;
    } else {
      const parent = parentElement(target);
      const siblings = parent ? children(parent) : [];
      const index = siblings.indexOf(target);
      const next =
        direction === "ArrowLeft"
          ? findTarget(siblings.slice(0, index), true)
          : findTarget(siblings.slice(index + 1));
      target = next ?? target;
    }
    target?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    notice = target
      ? `Target ${description(target)}. ${selected.length} selected.`
      : "No selectable elements.";
    render();
  }
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
      onCancel();
    } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      const targetControl = shadow.activeElement?.hasAttribute("data-picker-target");
      if (inToolbar(event) && !targetControl) return;
      consume(event);
      browse(event.key);
    } else if (event.key === " " && !inToolbar(event)) {
      suppress(event);
      toggleTarget();
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
    if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
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
  (shadow.querySelector("[data-picker-target]") as HTMLElement | null)?.focus();
  return { stop, setTheme };
}
