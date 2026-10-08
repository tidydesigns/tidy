import { captureElement } from "./browser-capture";
import { currentViewport, sameViewport, type CaptureViewport } from "./capture-effects";
import { captureSourceUrl } from "./capture-source";

function rootFor(selector?: string) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) throw new Error("Capture selector did not match an element.");
  return root;
}

const api = {
  version: 1,
  async prepare(options: { selector?: string } = {}) {
    const root = rootFor(options.selector);
    await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await Promise.race([
      Promise.all(
        [...(root instanceof HTMLImageElement ? [root] : []), ...root.querySelectorAll("img")]
          .slice(0, 2000)
          .map((image) => image.decode().catch(() => {})),
      ),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    return { ...currentViewport(), url: captureSourceUrl(location.href) };
  },
  async capture(
    options: {
      selector?: string;
      screenshot?: string;
      viewport?: CaptureViewport & { url: string };
    } = {},
  ) {
    if (
      options.screenshot &&
      (!options.viewport ||
        !sameViewport(options.viewport, currentViewport()) ||
        options.viewport.url !== captureSourceUrl(location.href))
    ) {
      throw new Error(
        "Screenshot needs matching prepare() metadata. Keep the page and viewport unchanged between prepare, screenshot and capture.",
      );
    }
    if (options.screenshot && !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(options.screenshot))
      throw new Error("Supply a PNG viewport screenshot as a base64 data URL.");
    return captureElement(
      rootFor(options.selector),
      options.selector ? "element" : "page",
      options.screenshot,
      options.viewport,
    );
  },
};

Object.defineProperty(globalThis, "__tidyCapture", { value: api, configurable: true });
