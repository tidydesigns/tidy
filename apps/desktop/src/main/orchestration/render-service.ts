import { CloudCompute } from "../cloud/cloud-compute";
import { BrowserRuntime } from "../browser/runtime";
import { AgentOperationError } from "./contracts";
import type { CanvasSnapshot, CanvasRenderResult } from "./canvas-service";
import type { BrowserContext } from "puppeteer-core";

async function untilAborted<T>(signal: AbortSignal, action: () => Promise<T>) {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([action(), cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class CanvasRenderer {
  private readonly compute = new CloudCompute(4);
  private readonly runtime = new BrowserRuntime(
    () => {},
    () => {},
  );
  private active = false;
  private closed = false;

  async render(snapshot: CanvasSnapshot): Promise<CanvasRenderResult> {
    snapshot.signal.throwIfAborted();
    if (this.closed)
      throw new AgentOperationError("UNAVAILABLE", "The canvas renderer is closing.");
    if (this.active)
      throw new AgentOperationError("BUSY", "A canvas preview is rendering. Retry shortly.");
    this.active = true;
    try {
      const width = Math.max(1, Math.min(4096, Math.ceil(snapshot.width)));
      const root = snapshot.document.nodes.find((node) => node.id === snapshot.rootId);
      if (!root) throw new AgentOperationError("NOT_FOUND", "Render root not found.");
      const height = Math.max(1, Math.min(4096, Math.ceil(root.box.height)));
      if (width * height > 16_000_000)
        throw new AgentOperationError("BUSY", "Preview exceeds the pixel limit.");
      const markup = await this.compute.renderMarkup({
        document: snapshot.document,
        rootId: snapshot.rootId,
        assets: snapshot.assets,
        width,
      });
      snapshot.signal.throwIfAborted();
      const browser = await untilAborted(snapshot.signal, () => this.runtime.get());
      snapshot.signal.throwIfAborted();
      let context: BrowserContext | undefined;
      let closingContext: Promise<void> | undefined;
      const closeContext = () => {
        if (!context) return Promise.resolve();
        return (closingContext ??= context.close().catch(() => {}));
      };
      const abort = () => {
        void closeContext();
      };
      snapshot.signal.addEventListener("abort", abort, { once: true });
      try {
        const ownedContext = await untilAborted(snapshot.signal, async () => {
          context = await browser.createBrowserContext();
          if (snapshot.signal.aborted) {
            await closeContext();
            snapshot.signal.throwIfAborted();
          }
          return context;
        });
        snapshot.signal.throwIfAborted();
        const page = await ownedContext.newPage();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(15_000);
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          const url = request.url();
          void (
            url.startsWith("data:") || url === "about:blank" ? request.continue() : request.abort()
          ).catch(() => {});
        });
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        await page.setContent(
          `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none';"><style>html,body{margin:0;padding:0}*{box-sizing:border-box}</style></head><body>${markup}</body></html>`,
          { waitUntil: "load" },
        );
        snapshot.signal.throwIfAborted();
        const pixels = await page.screenshot({ type: "png", omitBackground: true });
        snapshot.signal.throwIfAborted();
        if (pixels.byteLength > 2 * 1024 * 1024)
          throw new AgentOperationError("BUSY", "Preview image exceeds 2 MB.");
        return {
          kind: "rendered",
          mime_type: "image/png",
          data: Buffer.from(pixels).toString("base64"),
          width,
          height,
          limitations: [
            ...snapshot.warnings,
            "Fonts use the host's installed fonts; unavailable font families may be substituted.",
            "The preview uses the root frame's recorded size. Interactive behavior is disabled.",
          ],
        };
      } finally {
        snapshot.signal.removeEventListener("abort", abort);
        await closeContext();
      }
    } finally {
      this.active = false;
    }
  }
  async close() {
    this.closed = true;
    await Promise.all([this.runtime.close(), this.compute.close()]);
  }
}
