import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { currentViewport } from "@bella/design/capture-effects";
import { captureElement } from "../lib/capture";
import { captureSelection } from "../lib/capture-selection";
import { startElementPicker } from "../lib/element-picker";

export default defineContentScript({
  registration: "runtime",
  main(ctx) {
    let selected: Element[] = [];
    let picker: ReturnType<typeof startElementPicker> | undefined;
    let snapshotObserver: MutationObserver | undefined;
    let snapshotChanged = true;
    let disposed = false;
    const invalidateSnapshot = () => {
      snapshotChanged = true;
    };
    const stopSnapshot = () => {
      snapshotChanged = true;
      snapshotObserver?.disconnect();
      snapshotObserver = undefined;
      window.removeEventListener("scroll", invalidateSnapshot, true);
      window.removeEventListener("resize", invalidateSnapshot);
    };
    const screenshotValid = () => {
      if (snapshotObserver?.takeRecords().length) snapshotChanged = true;
      return !snapshotChanged;
    };
    const stopPicking = () => {
      picker?.stop();
      picker = undefined;
    };
    const pick = (theme: unknown) => {
      stopSnapshot();
      stopPicking();
      selected = [];
      picker = startElementPicker({
        theme,
        onConfirm(elements) {
          selected = elements;
          picker = undefined;
          void browser.runtime.sendMessage({ type: "bella:picked" }).catch(() => undefined);
        },
        onCancel() {
          picker = undefined;
          selected = [];
          void browser.runtime.sendMessage({ type: "bella:cancelled" }).catch(() => undefined);
        },
      });
    };
    const themeChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "local" && changes.theme) picker?.setTheme(changes.theme.newValue);
    };
    browser.storage.onChanged.addListener(themeChanged);
    const onMessage: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
      message,
      sender,
      respond,
    ) => {
      if (sender.id !== browser.runtime.id || !message || typeof message !== "object") return;
      if (message.type === "bella:pick") {
        pick(message.theme);
        respond({ data: true });
        return;
      }
      if (message.type === "bella:stop") {
        stopSnapshot();
        stopPicking();
        respond({ data: true });
        return;
      }
      if (message.type === "bella:prepare-capture") {
        stopSnapshot();
        stopPicking();
        // Paint picker removal and let loaded fonts settle before the screenshot.
        Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))])
          .then(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          )
          .then(() => {
            if (disposed) return respond({ error: "The capture was interrupted. Start again." });
            snapshotChanged = false;
            snapshotObserver = new MutationObserver(invalidateSnapshot);
            const observe = (target: Node) =>
              snapshotObserver!.observe(target, {
                subtree: true,
                childList: true,
                attributes: true,
                characterData: true,
              });
            observe(document.documentElement);
            const pending: Element[] = [document.documentElement];
            let visited = 0;
            while (pending.length) {
              if (++visited > 15000) {
                snapshotChanged = true;
                break;
              }
              const element = pending.pop()!;
              for (const child of element.children) pending.push(child);
              if (element.shadowRoot) {
                observe(element.shadowRoot);
                for (const child of element.shadowRoot.children) pending.push(child);
              }
            }
            window.addEventListener("scroll", invalidateSnapshot, true);
            window.addEventListener("resize", invalidateSnapshot);
            respond({ data: currentViewport() });
          });
        return true;
      }
      if (message.type !== "bella:capture") return;
      stopPicking();
      const capture =
        message.mode === "element"
          ? captureSelection(
              selected,
              message.screenshot,
              message.screenshotViewport,
              screenshotValid,
            )
          : captureElement(document.body, "page", message.screenshot, message.screenshotViewport, {
              screenshotValid,
            });
      capture
        .then(
          (data) => respond({ data }),
          (error) =>
            respond({
              error: error instanceof Error ? error.message : "Could not capture this page.",
            }),
        )
        .finally(stopSnapshot);
      return true;
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => {
      disposed = true;
      stopSnapshot();
      stopPicking();
      browser.runtime.onMessage.removeListener(onMessage);
      browser.storage.onChanged.removeListener(themeChanged);
    });
  },
});
