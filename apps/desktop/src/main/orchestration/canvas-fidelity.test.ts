import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import sharp from "sharp";
import type { Browser, Page } from "puppeteer-core";
import {
  designNodeSchema,
  blankDesignDocument,
  parseDesignDocument,
  type DesignNode,
} from "@tidy/design/document";
import { BrowserRuntime } from "../browser/runtime";
import { CanvasRenderer, canvasResourceReadiness } from "./render-service";
import { CanvasService } from "./canvas-service";
import { ProjectStore } from "../workspace/project-store";
import type { AgentScope } from "./contracts";
import { bundledCanvasFontCss } from "../../../scripts/canvas-fonts";
import type { ThreadExample } from "../../../scripts/fixtures/canvas-fidelity";

const browserTest = process.env.TIDY_TEST_CANVAS_BROWSER === "1" ? test : test.skip;
const runtime = new BrowserRuntime(
  () => {},
  () => {},
);
const renderer = new CanvasRenderer();
let browser: Browser;
let script = "",
  css = "";
let directory = "";
beforeAll(async () => {
  if (process.env.TIDY_TEST_CANVAS_BROWSER !== "1") return;
  directory = await mkdtemp(join(tmpdir(), "canvas-fidelity-"));
  const result = await build({
    configFile: false,
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      "import.meta.url": JSON.stringify("https://canvas-fixture.invalid/fixture.js"),
    },
    root: resolve(import.meta.dir, "../../.."),
    plugins: [react(), tailwindcss()],
    logLevel: "error",
    build: {
      write: false,
      assetsInlineLimit: 1024 * 1024,
      lib: {
        entry: resolve(import.meta.dir, "../../../scripts/fixtures/canvas-fidelity.tsx"),
        formats: ["iife"],
        name: "CanvasFidelity",
      },
    },
  });
  const builds = Array.isArray(result) ? result : [result];
  for (const build of builds) {
    if (!("output" in build)) throw new Error("Unexpected fidelity fixture build output.");
    for (const output of build.output) {
      if (output.type === "chunk") script += output.code;
      else if (output.fileName.endsWith(".css")) css += output.source.toString();
    }
  }
  css += Object.values(await bundledCanvasFontCss()).join("\n");
  css +=
    ":root{color-scheme:light;background:#f7f7f7}html,body{margin:0;padding:0}*{animation:none!important;transition:none!important;caret-color:transparent!important}";
  browser = await runtime.get();
}, 60000);
afterAll(async () => {
  await renderer.close();
  await runtime.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixturePage(width: number, height: number) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) =>
    errors.push(error instanceof Error ? (error.stack ?? String(error)) : String(error)),
  );
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    void (
      url === "https://canvas-fixture.invalid/"
        ? request.respond({
            contentType: "text/html",
            body: `<html><head><style>${css}</style></head><body></body></html>`,
          })
        : url === "https://canvas-fixture.invalid/fixture.js"
          ? request.respond({ contentType: "application/javascript", body: script })
          : url.startsWith("data:")
            ? request.continue()
            : request.abort()
    ).catch(() => {});
  });
  await page.goto("https://canvas-fixture.invalid/");
  await page.addScriptTag({ url: "https://canvas-fixture.invalid/fixture.js" });
  expect(errors).toEqual([]);
  return page;
}
async function ready(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode()));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}
async function compare(source: Uint8Array, preview: Uint8Array) {
  const a = await sharp(source)
    .flatten({ background: "#f7f7f7" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const b = await sharp(preview)
    .flatten({ background: "#f7f7f7" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(a.info).toEqual(b.info);
  let total = 0,
    changed = 0;
  const diff = Buffer.alloc(a.data.length);
  for (let index = 0; index < a.data.length; index += 4) {
    let delta = 0;
    for (let channel = 0; channel < 3; channel++) {
      const value = Math.abs(a.data[index + channel] - b.data[index + channel]);
      total += value;
      delta = Math.max(delta, value);
      diff[index + channel] = value;
    }
    diff[index + 3] = 255;
    if (delta > 16) changed++;
  }
  return {
    changed_fraction: changed / (a.info.width * a.info.height),
    mean_channel_difference: total / (a.info.width * a.info.height * 3),
    diff: await sharp(diff, { raw: a.info }).png().toBuffer(),
  };
}
async function artifacts(
  name: string,
  source: Uint8Array,
  preview: Uint8Array,
  diff: Uint8Array,
  document?: unknown,
) {
  const output = process.env.TIDY_CANVAS_FIDELITY_OUTPUT;
  if (!output) return;
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(join(output, `${name}-source.png`), source),
    writeFile(join(output, `${name}-preview.png`), preview),
    writeFile(join(output, `${name}-diff.png`), diff),
    ...(document
      ? [writeFile(join(output, `${name}.json`), JSON.stringify(document, null, 2))]
      : []),
  ]);
}

browserTest(
  "ThreadCard states reproduce source layout, real SVG artwork and editable typography through scoped canvas tools",
  async () => {
    const output = process.env.TIDY_CANVAS_FIDELITY_OUTPUT;
    if (output) await mkdir(output, { recursive: true });
    const root = output
      ? await mkdtemp(join(output, "thread-card-project-"))
      : join(directory, "project");
    if (!output) await mkdir(root);
    const store = new ProjectStore(join(directory, "state"));
    await store.initialize();
    const project = await store.register(root);
    const service = new CanvasService({
      store,
      receipts: store.processState,
      authorize: async () => {},
      onChange: async () => {},
      inspectAsset: (data, signal) => renderer.inspectAsset(data, signal),
      renderSnapshot: (snapshot) => renderer.render(snapshot),
    });
    const page = await fixturePage(244, 100);
    const measurements = [];
    try {
      for (const example of [
        "empty",
        "working",
        "completed-response",
        "completed-response-with-pr",
        "done",
      ] satisfies ThreadExample[]) {
        await page.evaluate((example) => window.canvasFidelity.thread(example), example);
        await ready(page);
        const captured = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>(".thread-item")!;
          const bounds = root.getBoundingClientRect();
          const color = (value: string) => {
            const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
            return `#${channels
              .slice(0, 3)
              .map((value) => Math.round(value).toString(16).padStart(2, "0"))
              .join("")}`;
          };
          const box = (element: Element) => {
            const rect = element.getBoundingClientRect();
            return {
              x: rect.x - bounds.x,
              y: rect.y - bounds.y,
              width: rect.width,
              height: rect.height,
            };
          };
          const texts = [
            ".thread-title",
            ".thread-time",
            ".thread-card-status",
            ".thread-pull-requests > a > span",
            ".thread-done",
          ].flatMap((selector, index) => {
            const element = root.querySelector<HTMLElement>(selector);
            if (
              !element ||
              getComputedStyle(element).visibility === "hidden" ||
              getComputedStyle(element).opacity === "0"
            )
              return [];
            const textNodes = [...element.childNodes].filter(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            );
            if (!textNodes.length) return [];
            const range = document.createRange();
            range.selectNodeContents(element);
            if (selector === ".thread-card-status") {
              range.setStartBefore(textNodes[0]);
              range.setEndAfter(textNodes.at(-1)!);
            }
            const style = getComputedStyle(element);
            const leaf = selector === ".thread-card-status" || selector === ".thread-done";
            const rect = leaf ? range.getBoundingClientRect() : element.getBoundingClientRect();
            const lineHeight = parseFloat(style.lineHeight);
            const lineTop = leaf
              ? element.getBoundingClientRect().y +
                (element.getBoundingClientRect().height - lineHeight) / 2
              : rect.y;
            return [
              {
                id: `text-${index}`,
                name: selector,
                text: textNodes.map((node) => node.textContent).join(""),
                box: {
                  x: rect.x - bounds.x,
                  y: lineTop - bounds.y,
                  width: rect.width + (leaf ? 1 : 0),
                  height: leaf ? lineHeight : rect.height,
                },
                paddingRight: leaf ? 0 : parseFloat(style.paddingRight),
                style: {
                  fontFamily: "Instrument Sans",
                  fontSize: parseFloat(style.fontSize),
                  fontWeight: Number(style.fontWeight),
                  fontVariantNumeric: style.fontVariantNumeric,
                  lineHeightMode: "px" as const,
                  lineHeightPx: lineHeight,
                  color: color(style.color),
                  textWrap: "nowrap" as const,
                  textOverflow:
                    selector === ".thread-title" ? ("ellipsis" as const) : ("clip" as const),
                },
              },
            ];
          });
          const mark = root.querySelector<HTMLElement>(".model-provider-icon")!;
          const svgs = [
            ...root.querySelectorAll<SVGSVGElement>(
              ".thread-status-symbol svg, .chat-pull-request-icon",
            ),
          ].map((svg, index) => {
            const clone = svg.cloneNode(true) as SVGSVGElement;
            const elements = [svg, ...svg.querySelectorAll("*")],
              clones = [clone, ...clone.querySelectorAll("*")];
            elements.forEach((element, i) => {
              const style = getComputedStyle(element);
              clones[i].removeAttribute("class");
              for (const key of [
                "fill",
                "stroke",
                "stroke-width",
                "stroke-linecap",
                "stroke-linejoin",
              ]) {
                let value = style.getPropertyValue(key);
                if (value.startsWith("rgb")) value = color(value);
                clones[i].setAttribute(key, value);
              }
            });
            clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
            return { id: `svg-${index}`, svg: clone.outerHTML, box: box(svg) };
          });
          const ring = root.querySelector<HTMLElement>(
            ".thread-state-running .thread-status-symbol > span",
          );
          return {
            conditions: {
              theme: "light",
              width: 244,
              device_scale_factor: devicePixelRatio,
              animations: "disabled",
              hover: matchMedia("(hover: hover)").matches ? "hover" : "none",
              pointer: matchMedia("(pointer: fine)").matches ? "fine" : "coarse",
              font_family: getComputedStyle(root).fontFamily,
            },
            height: bounds.height,
            texts,
            svgs,
            mark: { box: box(mark), color: color(getComputedStyle(mark).backgroundColor) },
            ring: ring ? { box: box(ring), color: color(getComputedStyle(ring).color) } : null,
            status: root.querySelector("[role=status]")?.getAttribute("aria-label"),
            done: root.querySelector(".thread-done")?.textContent,
          };
        });
        expect(captured.status).toBe(
          example === "working"
            ? "Working"
            : example.startsWith("completed")
              ? "Unread response"
              : undefined,
        );
        expect(captured.done).toBe(example === "done" ? "Reopen" : "Done");
        const source = await page.screenshot({
          type: "png",
          clip: { x: 0, y: 0, width: 244, height: captured.height },
        });
        const file = await store.createDesign(project.id);
        const scope: AgentScope = {
          projectId: project.id,
          threadId: randomUUID(),
          designIds: [file.id],
          writable: true,
          signal: new AbortController().signal,
        };
        const importSvg = (svg: string) =>
          service.importAsset(scope, {
            design_id: file.id,
            expected_version: file.version,
            source: { kind: "inline_svg", svg },
          });
        const logo = await importSvg(
          await readFile(
            resolve(import.meta.dir, "../../renderer/src/features/harnesses/openai.svg"),
            "utf8",
          ),
        );
        expect(logo.node.type).toBe("vector");
        const nodes: DesignNode[] = [
          designNodeSchema.parse({
            id: "card",
            parentId: null,
            type: "artboard",
            isComponent: true,
            name: `Thread card ${example}`,
            box: { x: 0, y: 0, width: 244, height: captured.height },
            style: { fill: "#f7f7f7", radius: 6, overflow: "hidden" },
          }),
        ];
        for (const text of captured.texts)
          nodes.push(designNodeSchema.parse({ ...text, type: "text", parentId: "card" }));
        nodes.push(
          designNodeSchema.parse({
            ...logo.node,
            id: "provider-mark",
            name: "Provider mark",
            parentId: "card",
            box: captured.mark.box,
            style: {
              ...("style" in logo.node ? logo.node.style : {}),
              paints: [{ id: "mark-fill", type: "solid", color: captured.mark.color }],
            },
          }),
        );
        for (const svg of captured.svgs) {
          const asset = await importSvg(svg.svg);
          nodes.push(
            designNodeSchema.parse({
              ...asset.node,
              id: svg.id,
              name: "Status artwork",
              parentId: "card",
              box: svg.box,
            }),
          );
        }
        if (captured.ring) {
          nodes.push(
            designNodeSchema.parse({
              id: "working-ring",
              name: "Working indicator",
              type: "container",
              parentId: "card",
              box: captured.ring.box,
              style: {
                radius: 6.5,
                borderColor: captured.ring.color,
                borderWidth: 1.5,
                borderStyle: "dashed",
              },
            }),
          );
        }
        const edited = await service.edit(scope, {
          design_id: file.id,
          expected_version: file.version,
          request_id: randomUUID(),
          operations: [
            { kind: "delete", node_ids: file.document.nodes.map((node) => node.id) },
            { kind: "add", nodes },
          ],
        });
        const result = await service.render(scope, {
          design_id: file.id,
          expected_version: edited.version,
          node_id: "card",
          strict_fidelity: true,
        });
        if (result.kind !== "rendered") throw new Error("Preview unavailable.");
        expect(result.resources_complete).toBe(true);
        expect(result.fidelity).toBe("unverified");
        expect(nodes.length).toBeLessThanOrEqual(9);
        const preview = Buffer.from(result.data, "base64");
        const parity = await compare(source, preview);
        measurements.push({
          example,
          changed_fraction: parity.changed_fraction,
          mean_channel_difference: parity.mean_channel_difference,
          layers: nodes.length,
          project_directory: root,
          conditions: captured.conditions,
        });
        await artifacts(
          example,
          source,
          preview,
          parity.diff,
          (await store.readDesign(project.id, file.id)).document,
        );
        expect(parity.changed_fraction).toBeLessThan(0.01);
        expect(parity.mean_channel_difference).toBeLessThan(0.75);
      }
      if (process.env.TIDY_CANVAS_FIDELITY_OUTPUT)
        await writeFile(
          join(process.env.TIDY_CANVAS_FIDELITY_OUTPUT, "thread-card-comparison.json"),
          JSON.stringify(measurements, null, 2),
        );
    } finally {
      await page.close();
      await service.close();
    }
  },
  120000,
);

browserTest(
  "editor artwork and MCP preview agree for type, SVGs, images, flex/grid, clipping, effects and variants",
  async () => {
    const assetId = randomUUID();
    const data = `data:image/png;base64,${(
      await sharp({ create: { width: 32, height: 24, channels: 4, background: "#93c5fd" } })
        .png()
        .toBuffer()
    ).toString("base64")}`;
    const logo = await renderer.inspectAsset(
      await readFile(
        resolve(import.meta.dir, "../../renderer/src/features/harnesses/openai.svg"),
      ).then((bytes) => `data:image/svg+xml;base64,${bytes.toString("base64")}`),
      new AbortController().signal,
    );
    if (!logo.svg?.editable) throw new Error("Expected editable provider mark.");
    const node = (value: unknown) => designNodeSchema.parse(value);
    const frame = { x: 0, y: 0, width: 448, height: 80 };
    const document = parseDesignDocument({
      ...blankDesignDocument(),
      nodes: [
        node({
          id: "frame",
          name: "Visual parity",
          type: "artboard",
          parentId: null,
          box: { x: 0, y: 0, width: 480, height: 400 },
          layout: "flex-column",
          padding: 16,
          gap: 12,
          style: {
            fill: "#f7f7f7",
            overflow: "hidden",
            radius: 12,
            borderWidth: 1,
            borderColor: "#d1d5db",
          },
        }),
        node({
          id: "title",
          name: "Typography",
          type: "text",
          parentId: "frame",
          box: { ...frame, height: 52 },
          widthMode: "fill",
          text: "Instrument Sans weights and wrapping across two lines",
          style: {
            fontFamily: "Instrument Sans",
            fontSize: 20,
            fontWeight: 700,
            lineHeightMode: "px",
            lineHeightPx: 24,
            maxLines: 2,
            color: "#292929",
          },
        }),
        node({
          id: "row",
          name: "Flex row",
          type: "container",
          parentId: "frame",
          box: frame,
          widthMode: "fill",
          layout: "flex-row",
          padding: 8,
          gap: 12,
          align: "center",
          style: {
            fill: "#ffffff",
            radius: 8,
            shadows: [{ x: 0, y: 2, blur: 4, spread: 0, color: "#00000020" }],
          },
        }),
        node({
          ...logo.svg.editable,
          id: "mark",
          name: "Editable mark",
          type: "vector",
          parentId: "row",
          box: { x: 0, y: 0, width: 32, height: 32 },
        }),
        node({
          id: "ellipsis",
          name: "Truncated text",
          type: "text",
          parentId: "row",
          box: { ...frame, width: 190, height: 20 },
          widthMode: "fill",
          text: "A long editable label that must truncate at the available width",
          style: {
            fontFamily: "Instrument Sans",
            fontSize: 14,
            fontWeight: 500,
            lineHeightMode: "px",
            lineHeightPx: 20,
            textWrap: "nowrap",
            textOverflow: "ellipsis",
            color: "#424242",
          },
        }),
        node({
          id: "image",
          name: "Raster image",
          type: "image",
          parentId: "row",
          assetId,
          box: { x: 0, y: 0, width: 48, height: 48 },
          style: { objectFit: "cover", radius: 8 },
        }),
        node({
          id: "grid",
          name: "Grid",
          type: "container",
          parentId: "frame",
          box: { ...frame, height: 100 },
          widthMode: "fill",
          layout: "grid",
          gridColumns: 2,
          gap: 8,
          padding: 8,
          style: { fill: "#e5e7eb", radius: 8, overflow: "hidden" },
        }),
        ...[400, 500, 600, 700].map((weight, index) =>
          node({
            id: `weight-${weight}`,
            name: `Weight ${weight}`,
            type: "text",
            parentId: "grid",
            box: { x: 0, y: 0, width: 180, height: 24 },
            widthMode: "fill",
            text: `Weight ${weight}`,
            style: {
              fontFamily: "Instrument Sans",
              fontSize: 16,
              fontWeight: weight,
              lineHeight: 1.5,
              color: index % 2 ? "#1d4ed8" : "#292929",
            },
          }),
        ),
        node({
          id: "component",
          name: "Variant component",
          type: "container",
          parentId: "frame",
          box: { ...frame, height: 48 },
          widthMode: "fill",
          layout: "flex-row",
          align: "center",
          padding: 12,
          isComponent: true,
          variants: {
            default: "empty",
            options: {
              empty: {},
              completed: {
                root: { style: { fill: "#dcfce7" } },
                children: {
                  "component-text": { text: "Completed response", style: { color: "#15803d" } },
                },
              },
            },
          },
          variant: "completed",
          style: { fill: "#ffffff", radius: 8, borderWidth: 1, borderColor: "#15803d" },
        }),
        node({
          id: "component-text",
          name: "Variant label",
          type: "text",
          parentId: "component",
          box: { x: 0, y: 0, width: 200, height: 20 },
          text: "Empty",
          style: {
            fontFamily: "Instrument Sans",
            fontSize: 14,
            fontWeight: 500,
            lineHeightMode: "px",
            lineHeightPx: 20,
            color: "#292929",
          },
        }),
      ],
    });
    const assets = { [assetId]: data };
    const page = await fixturePage(480, 400);
    try {
      await page.evaluate(
        ({ document, assets }) => window.canvasFidelity.artwork(document, assets),
        { document, assets },
      );
      await ready(page);
      const source = await page.screenshot({ type: "png" });
      const result = await renderer.render({
        document,
        assets,
        rootId: "frame",
        width: 480,
        warnings: [],
        strictFidelity: true,
        signal: new AbortController().signal,
        projectId: "fixture",
        designId: "fixture",
        version: "fixture",
      });
      expect(result.diagnostics).toEqual([]);
      const preview = Buffer.from(result.data, "base64");
      const parity = await compare(source, preview);
      await artifacts("editor-parity", source, preview, parity.diff, document);
      expect(parity.changed_fraction).toBeLessThan(0.005);
      expect(parity.mean_channel_difference).toBeLessThan(0.5);
    } finally {
      await page.close();
    }
  },
  60000,
);

browserTest(
  "asset inspection preserves safe unsupported SVGs and rejects active, external and malformed artwork",
  async () => {
    for (const format of ["png", "jpeg", "webp"] as const) {
      const bytes = await sharp({
        create: { width: 30, height: 20, channels: 3, background: "#15803d" },
      })
        .toFormat(format)
        .toBuffer();
      const size = await renderer.inspectAsset(
        `data:image/${format};base64,${bytes.toString("base64")}`,
        new AbortController().signal,
      );
      expect({ width: size.width, height: size.height }).toEqual({ width: 30, height: 20 });
    }
    const inspect = (svg: string) =>
      renderer.inspectAsset(
        `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
        new AbortController().signal,
      );
    const safe = await inspect(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><g transform="translate(2 2)"><rect width="10" height="10" fill="#ff0000"/></g></svg>',
    );
    expect(safe.svg?.editable).toBeUndefined();
    expect(safe.svg?.reason).toContain("Original SVG retained");
    for (const inner of [
      "<script>alert(1)</script>",
      "<foreignObject/>",
      '<image href="file:///etc/passwd"/>',
      '<image xmlns:q="http://www.w3.org/1999/xlink" q:href="https://outside.invalid/image.svg"/>',
      '<path onload="alert(1)"/>',
      '<style>@import "https://example.com";</style>',
      '<animate attributeName="x"/>',
      '<rect fill="url(https://example.com/image)"/>',
    ]) {
      await expect(
        inspect(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">${inner}</svg>`),
      ).rejects.toThrow();
    }
    await expect(
      inspect(
        '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
      ),
    ).rejects.toThrow();
    await expect(inspect("<svg><path></svg>")).rejects.toThrow();
    await expect(
      inspect(
        '<?xml-stylesheet href="https://outside.invalid/style.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
      ),
    ).rejects.toThrow();
  },
  60000,
);

browserTest(
  "resource deadlines retain existing errors and identify pending fonts and images",
  async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<span>Resource deadline</span>");
      await page.evaluate(() => {
        document.fonts.load = (spec) =>
          spec.includes("Broken")
            ? Promise.reject(new Error("font failed"))
            : new Promise(() => {});
        Image.prototype.decode = () => new Promise(() => {});
      });
      const diagnostics = await page.evaluate(canvasResourceReadiness, {
        requests: ["Broken font", "Pending font"].map((family) => ({
          family,
          weight: 400,
          italic: false,
          text: "Aa",
        })),
        assets: { "pending-logo": "data:image/png;base64,aW52YWxpZA==" },
        timeoutMs: 25,
      });
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "font_load_error",
            resource: expect.stringContaining("Broken font"),
          }),
          expect.objectContaining({
            kind: "resource_timeout",
            resource: expect.stringContaining("Pending font"),
          }),
          expect.objectContaining({ kind: "resource_timeout", resource: "pending-logo" }),
        ]),
      );
    } finally {
      await page.close();
    }
  },
);

browserTest(
  "strict preview rejects missing fonts and corrupt images and lenient output identifies substitutions",
  async () => {
    const document = parseDesignDocument({
      ...blankDesignDocument(),
      nodes: [
        designNodeSchema.parse({
          id: "frame",
          name: "Frame",
          parentId: null,
          type: "artboard",
          box: { x: 0, y: 0, width: 200, height: 60 },
          style: { fill: "#ffffff" },
        }),
        designNodeSchema.parse({
          id: "label",
          name: "Label",
          parentId: "frame",
          type: "text",
          text: "Missing font",
          box: { x: 0, y: 0, width: 100, height: 20 },
          style: { fontFamily: "Unavailable private font", fontSource: "local" },
        }),
      ],
    });
    const snapshot = {
      document,
      rootId: "frame",
      width: 200,
      assets: {},
      warnings: [],
      signal: new AbortController().signal,
      projectId: "fixture",
      designId: "fixture",
      version: "fixture",
    };
    await expect(renderer.render({ ...snapshot, strictFidelity: true })).rejects.toThrow(
      "missing_font",
    );
    const result = await renderer.render(snapshot);
    expect(result.resources_complete).toBe(false);
    expect(result.diagnostics?.[0].kind).toBe("missing_font");
    document.nodes[1].style = { fontFamily: "system-ui" };
    const generic = await renderer.render(snapshot);
    expect(generic.diagnostics?.[0].kind).toBe("font_substitution");
    document.nodes[1].style = { fontFamily: "Instrument Sans" };
    document.nodes[1].text = "Wiśniewska-Kowalczyk";
    const bundled = await renderer.render({ ...snapshot, strictFidelity: true });
    expect(bundled.resources_complete).toBe(true);
    document.nodes[1].text = "Tolerance ±5%";
    await expect(renderer.render({ ...snapshot, strictFidelity: true })).rejects.toThrow(
      "font_substitution",
    );
    const substituted = await renderer.render(snapshot);
    expect(substituted.resources_complete).toBe(false);
    expect(substituted.diagnostics?.some((item) => item.kind === "font_substitution")).toBe(true);
    document.nodes[1].text = "Editable text";
    const assetId = randomUUID();
    document.nodes.push(
      designNodeSchema.parse({
        id: "broken",
        name: "Broken",
        parentId: "frame",
        type: "image",
        assetId,
        box: { x: 100, y: 0, width: 20, height: 20 },
      }),
    );
    await expect(
      renderer.render({
        ...snapshot,
        assets: { [assetId]: "data:image/png;base64,aW52YWxpZA==" },
        strictFidelity: true,
      }),
    ).rejects.toThrow("asset_decode_error");
  },
  60000,
);
