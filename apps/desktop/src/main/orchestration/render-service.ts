import { parseSvgElements } from "@tidy/editor/design/svg-path-import";
import { resolvedDocumentNodes } from "@tidy/design/design-tokens";
import { canvasFonts } from "./render-fonts";
import type { RenderDiagnostic } from "./render-diagnostics";
import { CloudCompute } from "../cloud/cloud-compute";
import { BrowserRuntime } from "../browser/runtime";
import { AgentOperationError } from "./contracts";
import type { CanvasSnapshot, CanvasRenderResult } from "./canvas-service";
import type { BrowserContext, Page } from "puppeteer-core";
import { rasterDimensions } from "./raster-dimensions";

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

/** Serialized into the isolated page; resource tracking must not capture host values. */
export async function canvasResourceReadiness({
  requests,
  assets,
  timeoutMs = 10000,
}: {
  requests: Awaited<ReturnType<typeof canvasFonts>>["requests"];
  assets: Record<string, string>;
  timeoutMs?: number;
}): Promise<RenderDiagnostic[]> {
  const diagnostics: RenderDiagnostic[] = [];
  const pending = new Map<string, string>();
  const load = async (
    key: string,
    resource: string,
    kind: "font_load_error" | "asset_decode_error",
    action: () => Promise<unknown>,
  ) => {
    pending.set(key, resource);
    try {
      await action();
    } catch {
      diagnostics.push({
        kind,
        resource,
        message:
          kind === "font_load_error"
            ? "Embedded font could not be loaded."
            : "Asset could not be decoded.",
      });
    } finally {
      pending.delete(key);
    }
  };
  const ready = Promise.all([
    ...requests.map((request, index) => {
      const spec = `${request.italic ? "italic" : "normal"} ${request.weight} 16px ${JSON.stringify(request.face ?? request.family)}`;
      return load(`font:${index}`, spec, "font_load_error", async () => {
        const faces = await document.fonts.load(spec, request.text || "Aa");
        if (faces.some((face) => face.status !== "loaded")) throw new Error("Font did not load.");
      });
    }),
    load("font-set", "document.fonts", "font_load_error", () => document.fonts.ready),
    ...Object.entries(assets).map(([id, data]) =>
      load(`asset:${id}`, id, "asset_decode_error", async () => {
        const image = new Image();
        image.src = data;
        await image.decode();
      }),
    ),
    ...[...document.images].map((image, index) =>
      load(
        `image:${index}`,
        image.getAttribute("data-asset-id") ?? (image.alt || `image:${index}`),
        "asset_decode_error",
        () => image.decode(),
      ),
    ),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          for (const resource of pending.values())
            diagnostics.push({
              kind: "resource_timeout",
              resource,
              message: "Preview resource did not finish loading before the deadline.",
            });
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return [...diagnostics];
}

async function renderedFontSubstitutions(page: Page): Promise<RenderDiagnostic[]> {
  const count = await page.evaluate(() => {
    const parents = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (
        walker.currentNode.textContent?.trim() &&
        parent?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        parents.add(parent);
    }
    for (const parent of parents) parent.setAttribute("data-canvas-font-audit", "");
    return parents.size;
  });
  if (!count) return [];
  const session = await page.createCDPSession();
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeIds } = await session.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: "[data-canvas-font-audit]",
    });
    const families = new Set<string>();
    for (let offset = 0; offset < nodeIds.length; offset += 8) {
      const results = await Promise.all(
        nodeIds
          .slice(offset, offset + 8)
          .map((nodeId) => session.send("CSS.getPlatformFontsForNode", { nodeId })),
      );
      for (const { fonts } of results)
        for (const font of fonts)
          if (!font.isCustomFont && font.glyphCount) families.add(font.familyName);
    }
    return [...families].map((family) => ({
      kind: "font_substitution",
      resource: family,
      message: `Host font ${JSON.stringify(family)} supplied rendered glyphs that were not embedded.`,
    }));
  } finally {
    await session.detach().catch(() => {});
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

  async inspectAsset(data: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.closed)
      throw new AgentOperationError("UNAVAILABLE", "The canvas renderer is closing.");
    if (this.active)
      throw new AgentOperationError(
        "BUSY",
        "A canvas preview or import is running. Retry shortly.",
      );
    if (!data.startsWith("data:image/svg+xml;base64,")) {
      const header = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(data);
      const size =
        header && rasterDimensions(Buffer.from(data.slice(header[0].length), "base64"), header[1]);
      if (!size || !size.width || !size.height)
        throw new AgentOperationError(
          "CONFLICT",
          "Image header has invalid or missing dimensions. Choose a PNG, JPEG or WebP image.",
        );
      if (size.width * size.height > 16_000_000)
        throw new AgentOperationError("BUSY", "Imported image must contain at most 16 megapixels.");
    }
    this.active = true;
    let context: BrowserContext | undefined;
    const abort = () => {
      void context?.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const browser = await untilAborted(signal, () => this.runtime.get());
      await untilAborted(signal, async () => {
        context = await browser.createBrowserContext();
        if (signal.aborted) {
          await context.close();
          signal.throwIfAborted();
        }
      });
      const page = await context!.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        void (request.url().startsWith("data:") ? request.continue() : request.abort()).catch(
          () => {},
        );
      });
      let svg;
      if (data.startsWith("data:image/svg+xml;base64,")) {
        const source = Buffer.from(data.slice(data.indexOf(",") + 1), "base64").toString("utf8");
        const elements = await page.evaluate(parseSvgElements, source);
        svg = await untilAborted(signal, () => this.compute.inspectSvg(elements));
      }
      const size = await page.evaluate(async (data) => {
        const image = new Image();
        image.src = data;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      }, data);
      signal.throwIfAborted();
      if (!size.width || !size.height || size.width * size.height > 16_000_000)
        throw new AgentOperationError("BUSY", "Imported image must contain at most 16 megapixels.");
      return { ...size, svg };
    } finally {
      signal.removeEventListener("abort", abort);
      await context?.close().catch(() => {});
      this.active = false;
    }
  }

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
      const markup = await untilAborted(snapshot.signal, () =>
        this.compute.renderMarkup({
          document: snapshot.document,
          rootId: snapshot.rootId,
          assets: snapshot.assets,
          width,
        }),
      );
      snapshot.signal.throwIfAborted();
      const fonts = await untilAborted(snapshot.signal, () =>
        canvasFonts(resolvedDocumentNodes(snapshot.document), snapshot.signal),
      );
      const diagnostics: RenderDiagnostic[] = [
        ...(snapshot.diagnostics ?? []),
        ...fonts.diagnostics,
      ];
      if (snapshot.strictFidelity && diagnostics.length)
        throw new AgentOperationError(
          "UNAVAILABLE",
          `Strict preview is incomplete: ${JSON.stringify(diagnostics)}`,
        );
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
          `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; frame-src 'none';"><style>html,body{margin:0;padding:0}*{box-sizing:border-box;animation:none!important;transition:none!important;caret-color:transparent!important}${fonts.css}</style></head><body>${markup}</body></html>`,
          { waitUntil: "load" },
        );
        const readiness = await untilAborted(snapshot.signal, () =>
          page.evaluate(canvasResourceReadiness, {
            requests: fonts.requests,
            assets: snapshot.assets,
          }),
        );
        diagnostics.push(...readiness);
        diagnostics.push(
          ...(await untilAborted(snapshot.signal, () => renderedFontSubstitutions(page))),
        );
        if (snapshot.strictFidelity && diagnostics.length)
          throw new AgentOperationError(
            "UNAVAILABLE",
            `Strict preview is incomplete: ${JSON.stringify(diagnostics)}`,
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
          diagnostics,
          resources_complete: diagnostics.length === 0,
          fidelity: "unverified",
          limitations: [
            ...snapshot.warnings,
            "Resource readiness does not establish visual parity with the source UI.",
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
