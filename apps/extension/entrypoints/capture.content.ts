import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { currentViewport } from "@bella/design/capture-effects";
import { captureElement } from "../lib/capture";

export default defineContentScript({
  registration: "runtime",
  main(ctx) {
    let selected: Element | undefined;
    let stopPicking: (() => void) | undefined;

    const pick = () => {
      stopPicking?.();
      const host = document.createElement("div");
      host.dataset.bellaPicker = "";
      host.style.cssText =
        "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important";
      const shadow = host.attachShadow({ mode: "closed" });
      const outline = document.createElement("div");
      outline.style.cssText =
        "position:fixed;pointer-events:none;border:1px solid #888;background:rgba(220,220,220,.12);box-sizing:border-box";
      const hint = document.createElement("div");
      hint.textContent = "Click to copy · ↑ parent · ↓ child · Esc cancel";
      hint.style.cssText =
        "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:10px 14px;background:#fff;color:#333;border:1px solid #ddd;border-radius:8px;font:13px system-ui;box-shadow:0 2px 12px #0001;white-space:nowrap";
      shadow.append(outline, hint);
      document.documentElement.append(host);
      let target: Element | undefined;
      const highlight = () => {
        if (!target) return;
        const box = target.getBoundingClientRect();
        Object.assign(outline.style, {
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
        });
      };
      const move = (event: PointerEvent) => {
        target = event.composedPath().find((node) => node instanceof Element && node !== host) as
          | Element
          | undefined;
        highlight();
      };
      const suppress = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const click = (event: MouseEvent) => {
        suppress(event);
        if (!target) return;
        selected = target;
        cleanup();
        void browser.runtime.sendMessage({ type: "bella:picked" }).catch(() => undefined);
      };
      const key = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          suppress(event);
          cleanup();
          void browser.runtime.sendMessage({ type: "bella:cancelled" }).catch(() => undefined);
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          suppress(event);
          target =
            (event.key === "ArrowUp" ? target?.parentElement : target?.firstElementChild) ?? target;
          highlight();
        } else if (event.key === "Enter" && target) {
          suppress(event);
          selected = target;
          cleanup();
          void browser.runtime.sendMessage({ type: "bella:picked" }).catch(() => undefined);
        }
      };
      function cleanup() {
        host.remove();
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerdown", suppress, true);
        window.removeEventListener("pointerup", suppress, true);
        window.removeEventListener("click", click, true);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("scroll", highlight, true);
        stopPicking = undefined;
      }
      stopPicking = cleanup;
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerdown", suppress, true);
      window.addEventListener("pointerup", suppress, true);
      window.addEventListener("click", click, true);
      window.addEventListener("keydown", key, true);
      window.addEventListener("scroll", highlight, true);
      ctx.onInvalidated(cleanup);
    };
    const onMessage: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
      message,
      sender,
      respond,
    ) => {
      if (sender.id !== browser.runtime.id || !message || typeof message !== "object") return;
      if (message.type === "bella:pick") {
        pick();
        respond({ data: true });
        return;
      }
      if (message.type === "bella:stop") {
        stopPicking?.();
        respond({ data: true });
        return;
      }
      if (message.type === "bella:prepare-capture") {
        stopPicking?.();
        // Paint picker removal and let loaded fonts settle before the screenshot.
        Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))])
          .then(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          )
          .then(() => respond({ data: currentViewport() }));
        return true;
      }
      if (message.type !== "bella:capture") return;
      stopPicking?.();
      const root = message.mode === "element" ? selected : document.body;
      if (!root?.isConnected) {
        respond({ error: "Selected element disappeared. Select it again." });
        return;
      }
      captureElement(root, message.mode, message.screenshot, message.screenshotViewport).then(
        (data) => respond({ data }),
        (error) =>
          respond({
            error: error instanceof Error ? error.message : "Could not capture this page.",
          }),
      );
      return true;
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => {
      stopPicking?.();
      browser.runtime.onMessage.removeListener(onMessage);
    });
  },
});
