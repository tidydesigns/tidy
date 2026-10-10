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
    const stopPicking = () => {
      picker?.stop();
      picker = undefined;
    };
    const pick = (theme: unknown) => {
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
        stopPicking();
        respond({ data: true });
        return;
      }
      if (message.type === "bella:prepare-capture") {
        stopPicking();
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
      stopPicking();
      const capture =
        message.mode === "element"
          ? captureSelection(selected, message.screenshot, message.screenshotViewport)
          : captureElement(document.body, "page", message.screenshot, message.screenshotViewport);
      capture.then(
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
      stopPicking();
      browser.runtime.onMessage.removeListener(onMessage);
      browser.storage.onChanged.removeListener(themeChanged);
    });
  },
});
