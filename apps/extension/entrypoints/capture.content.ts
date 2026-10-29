import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { currentViewport } from "@tidy/design/capture-effects";
import { captureElement } from "@tidy/design/browser-capture";
import { captureSelection } from "../lib/capture-selection";
import { inspectScreenshotPage, waitForCapturePaint } from "../lib/capture-snapshot";
import { startElementPicker } from "../lib/element-picker";

export default defineContentScript({
  registration: "runtime",
  main(ctx) {
    let selected: Element[] = [];
    let picker: ReturnType<typeof startElementPicker> | undefined;
    let snapshotObserver: MutationObserver | undefined;
    let snapshotChanged = true;
    let disposed = false;
    let generation = 0;
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let screenshotSafe = false;
    let activeCaptureId: string | undefined;
    const invalidateSnapshot = () => {
      snapshotChanged = true;
    };
    const stopSnapshot = () => {
      generation++;
      clearTimeout(snapshotTimer);
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
    const pick = (theme: unknown, captureId: string) => {
      activeCaptureId = captureId;
      stopSnapshot();
      stopPicking();
      selected = [];
      picker = startElementPicker({
        theme,
        onConfirm(elements) {
          selected = elements;
          picker = undefined;
          void browser.runtime
            .sendMessage({ type: "bella:picked", captureId })
            .catch(() => undefined);
        },
        onCancel() {
          picker = undefined;
          selected = [];
          void browser.runtime
            .sendMessage({ type: "bella:cancelled", captureId })
            .catch(() => undefined);
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
        if (typeof message.captureId !== "string") return;
        pick(message.theme, message.captureId);
        respond({ data: true });
        return;
      }
      if (message.type === "bella:stop") {
        if (message.captureId !== activeCaptureId) return;
        activeCaptureId = undefined;
        stopSnapshot();
        stopPicking();
        selected = [];
        respond({ data: true });
        return;
      }
      if (message.type === "bella:prepare-capture") {
        if (typeof message.captureId !== "string") return;
        activeCaptureId = message.captureId;
        stopSnapshot();
        stopPicking();
        const preparedGeneration = generation;
        // Fonts and paint each have a bound, including when the tab is hidden.
        let fontTimer: ReturnType<typeof setTimeout> | undefined;
        Promise.race([
          document.fonts.ready,
          new Promise((resolve) => {
            fontTimer = setTimeout(resolve, 2000);
          }),
        ])
          .finally(() => clearTimeout(fontTimer))
          .then(() => waitForCapturePaint())
          .then((painted) => {
            if (disposed || generation !== preparedGeneration)
              return respond({ error: "The capture was interrupted. Start again." });
            snapshotChanged = false;
            snapshotObserver = new MutationObserver(invalidateSnapshot);
            screenshotSafe =
              painted &&
              inspectScreenshotPage(
                browser.dom?.openOrClosedShadowRoot as
                  | ((element: HTMLElement) => ShadowRoot | null)
                  | undefined,
                (target) =>
                  snapshotObserver!.observe(target, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    characterData: true,
                  }),
              );
            if (!screenshotSafe) {
              snapshotChanged = true;
              snapshotObserver.disconnect();
              snapshotObserver = undefined;
            } else {
              window.addEventListener("scroll", invalidateSnapshot, true);
              window.addEventListener("resize", invalidateSnapshot);
            }
            // A navigation, failed screenshot, or worker restart may prevent capture arriving.
            snapshotTimer = setTimeout(stopSnapshot, 10000);
            respond({ data: { ...currentViewport(), screenshotSafe } });
          })
          .catch(() => {
            if (generation === preparedGeneration) stopSnapshot();
            respond({ error: "Could not prepare this page. Try again." });
          });
        return true;
      }
      if (
        message.type !== "bella:capture" ||
        typeof message.captureId !== "string" ||
        message.captureId !== activeCaptureId
      )
        return;
      stopPicking();
      clearTimeout(snapshotTimer);
      const captureGeneration = generation;
      // Detect shadow roots attached between preparation and screenshot capture.
      const safeScreenshot =
        screenshotSafe &&
        screenshotValid() &&
        inspectScreenshotPage(
          browser.dom?.openOrClosedShadowRoot as
            | ((element: HTMLElement) => ShadowRoot | null)
            | undefined,
          () => {},
        )
          ? message.screenshot
          : undefined;
      const capture =
        message.mode === "element"
          ? captureSelection(selected, safeScreenshot, message.screenshotViewport, screenshotValid)
          : captureElement(document.body, "page", safeScreenshot, message.screenshotViewport, {
              screenshotValid,
            });
      capture
        .then(
          (data) => {
            if (disposed || generation !== captureGeneration)
              return respond({ error: "The capture was interrupted. Start again." });
            if (!safeScreenshot)
              data.document.warnings.push({
                message:
                  "Screenshot effects were omitted because the page could not be safely snapshotted; editable content was retained.",
              });
            respond({ data });
          },
          (error) =>
            respond({
              error: error instanceof Error ? error.message : "Could not capture this page.",
            }),
        )
        .finally(() => {
          if (generation === captureGeneration) {
            selected = [];
            stopSnapshot();
          }
        });
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
