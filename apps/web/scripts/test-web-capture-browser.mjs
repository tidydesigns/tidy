// Local deterministic regression: node apps/web/scripts/test-web-capture-browser.mjs
// Optional live check: append --shale. No writes to Tidy or the source website.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { browserCaptureScript } from "../lib/mcp/browser-capture.generated.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "tidy-capture-regression-"));
const bundle = path.join(output, "capture.js");
execFileSync(
  "bun",
  [
    "build",
    "apps/web/scripts/fixtures/capture-preview.ts",
    "--target=browser",
    `--outfile=${bundle}`,
  ],
  { cwd: repo, stdio: "pipe" },
);
const browser = await chromium.launch({ headless: true });
const live = process.argv.includes("--shale");
const width = live ? 1440 : 1000,
  height = live ? 1000 : 800;
try {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: process.argv.includes("--retina") ? 2 : 1,
  });
  if (live) await page.goto("https://shales.dev/", { waitUntil: "networkidle" });
  else {
    const trees = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" fill="#b4cac4"/>${Array.from(
      { length: 45 },
      (_, i) => {
        const x = (i * 67) % 300,
          y = (i * 43) % 400;
        return `<path d="M${x} ${y}l-35 110h70z" fill="${i % 2 ? "#163c35" : "#407563"}"/>`;
      },
    ).join("")}</svg>`;
    await page.setContent(`<style>
      *{box-sizing:border-box}body{margin:0;background:#f7f7f5;font:16px Arial}main{position:relative;width:1000px;height:800px;background:#f7f7f5}
      h1{position:absolute;left:300px;top:30px;margin:0;font-size:32px}button{position:absolute;left:420px;top:100px;z-index:4;background:#161818;color:white;border:0;padding:12px}
      .forest{position:absolute;left:0;top:150px;width:300px;height:600px;background-image:url('data:image/svg+xml,${encodeURIComponent(trees)}');background-size:cover;opacity:.8;mask-image:linear-gradient(90deg,#000 60%,transparent),linear-gradient(transparent,#000 20%,#000 80%,transparent);mask-composite:intersect}
      .right{left:700px;transform:scaleX(-1)}#laptop{position:absolute;left:310px;top:250px;width:380px;height:340px;perspective:800px}
      .screen{position:absolute;left:10px;top:0;width:360px;height:240px;background:#182820;border:12px solid #202322;border-radius:14px;transform:rotateX(-24deg) rotateY(8deg);transform-origin:50% 100%;box-shadow:0 6px 14px #0005}
      .screen span{display:block;margin:24px;color:white}.base{position:absolute;left:-20px;top:230px;width:420px;height:35px;background:linear-gradient(#aaa,#222);border-radius:0 0 15px 15px;box-shadow:0 12px 12px #0004}
    </style><main><h1>Editable heading</h1><button>Editable action</button><div class="forest" id="trees-left"></div><div class="forest right" id="trees-right"></div><div id="laptop"><div class="screen"><span>Workspace ready</span></div><div class="base"></div></div></main>`);
    // captureSourceUrl deliberately rejects about:blank; use a synthetic HTTP URL
    // through routing so the deterministic fixture never needs a network service.
    const html = await page.content();
    await page.route("https://capture.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
    await page.goto("https://capture.test/");
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
    for (const animation of document.getAnimations()) animation.pause();
  });
  await page.addScriptTag({ content: await readFile(bundle, "utf8") });
  await page.addScriptTag({ content: browserCaptureScript });
  const viewport = await page.evaluate(() => globalThis.__tidyCapture.prepare());
  const before = await page.screenshot({ path: path.join(output, "source.png") });
  const capture = await page.evaluate(
    async ({ screenshot, viewport }) => globalThis.__tidyCapture.capture({ screenshot, viewport }),
    { screenshot: `data:image/png;base64,${before.toString("base64")}`, viewport },
  );
  await assert.rejects(
    page.evaluate(
      async ({ screenshot, viewport }) =>
        globalThis.__tidyCapture.capture({
          screenshot,
          viewport: { ...viewport, scrollY: viewport.scrollY + 1 },
        }),
      { screenshot: `data:image/png;base64,${before.toString("base64")}`, viewport },
    ),
    /matching prepare/,
  );
  await writeFile(path.join(output, "capture.json"), JSON.stringify(capture));
  execFileSync(
    "bun",
    [
      "-e",
      'import {webCaptureSchema} from "./packages/design/web-capture.ts"; webCaptureSchema.parse(await Bun.file(process.argv[1]).json());',
      path.join(output, "capture.json"),
    ],
    { cwd: repo, stdio: "pipe" },
  );
  const masked = capture.document.nodes.filter((node) => node.name.includes("CSS mask"));
  const laptop = capture.document.nodes.find((node) => node.name.includes("3D perspective"));
  assert.ok(masked.length >= 2, "Both masked forests must be retained");
  assert.ok(laptop, "Perspective scene must be flattened as one layer");
  assert.ok(
    capture.document.nodes.some(
      (node) =>
        node.type === "text" && node.text.includes(live ? "Run coding" : "Editable heading"),
    ),
    "Heading remains editable",
  );
  assert.ok(
    capture.document.nodes.some(
      (node) =>
        node.type === "text" && node.text.includes(live ? "View source" : "Editable action"),
    ),
    "CTA remains editable",
  );
  assert.deepEqual(
    laptop.style,
    { objectFit: "fill" },
    "Never apply effects twice to rendered pixels",
  );
  for (const node of masked.slice(0, 2)) {
    const imageNodes =
      node.type === "container"
        ? capture.document.nodes.filter((child) => child.parentId === node.id)
        : [node];
    let transparent = false,
      faded = false;
    for (const imageNode of imageNodes) {
      const asset = capture.assets.find((asset) => asset.id === imageNode.assetId);
      const { data, info } = await sharp(Buffer.from(asset.base64, "base64"))
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.equal(info.channels, 4);
      transparent ||= data.some((value, index) => index % 4 === 3 && value === 0);
      faded ||= data.some((value, index) => index % 4 === 3 && value > 0 && value < 200);
    }
    assert.ok(transparent, "Mask retains transparent pixels");
    assert.ok(faded, "Mask retains its fade, not a hard clip");
  }
  await page.evaluate(
    async ({ capture, width, height }) => {
      const root = document.createElement("div");
      root.style.cssText = `position:relative;width:${width}px;height:${height}px;background:#fff;overflow:hidden`;
      const byId = new Map();
      for (const node of capture.document.nodes) {
        const el = document.createElement("div"),
          style = window.nodeStyle(node, "absolute", {});
        for (const [key, value] of Object.entries(style))
          if (value !== undefined)
            el.style[key] =
              typeof value === "number" &&
              !["opacity", "zIndex", "fontWeight", "lineHeight", "flexGrow", "flexShrink"].includes(
                key,
              )
                ? `${value}px`
                : String(value);
        if (node.type === "text") el.textContent = node.text;
        if (node.type === "image" || node.type === "vector") {
          const img = document.createElement("img"),
            asset = capture.assets.find((asset) => asset.id === node.assetId);
          img.src = `data:${asset.mimeType};base64,${asset.base64}`;
          Object.assign(img.style, window.imageStyle(node), { display: "block" }); // Match Tidy's Tailwind preflight.
          el.append(img);
          await img.decode();
        }
        (byId.get(node.parentId) || root).append(el);
        byId.set(node.id, el);
      }
      document.body.replaceChildren(root);
      document.body.style.cssText = "margin:0;padding:0";
      window.scrollTo(0, 0);
    },
    { capture, width, height },
  );
  const after = await page.screenshot({ path: path.join(output, "imported.png") });
  const pixels = await Promise.all(
    [before, after].map((bytes) =>
      sharp(bytes).resize(width, height).removeAlpha().raw().toBuffer(),
    ),
  );
  const regions = live
    ? [
        { name: "header logo icon", x: 130, y: 30, width: 28, height: 30 },
        { name: "GitHub header icon", x: 1207, y: 40, width: 20, height: 20 },
        { name: "GitHub CTA icon", x: 562, y: 308, width: 22, height: 22 },
        { name: "left forest", x: 0, y: 300, width: 250, height: 650 },
        { name: "right forest", x: 1210, y: 300, width: 230, height: 650 },
        // Compare the physical laptop, excluding its intentionally redacted controls.
        { name: "laptop top and sides", x: 340, y: 375, width: 790, height: 275 },
        { name: "laptop base", x: 275, y: 837, width: 918, height: 65 },
      ]
    : [
        { name: "left forest", x: 0, y: 150, width: 290, height: 550 },
        { name: "right forest", x: 710, y: 150, width: 290, height: 550 },
        { name: "laptop", x: 290, y: 230, width: 420, height: 320 },
      ];
  for (const region of regions) {
    let total = 0;
    for (let y = region.y; y < region.y + region.height; y++)
      for (let x = region.x; x < region.x + region.width; x++)
        for (let channel = 0; channel < 3; channel++) {
          const index = (y * width + x) * 3 + channel;
          total += Math.abs(pixels[0][index] - pixels[1][index]);
        }
    const mean = total / (region.width * region.height * 3);
    console.log(`${region.name}: mean channel difference ${mean.toFixed(3)} / 255`);
    assert.ok(mean < 3, `${region.name} deviates from the rendered source (${mean.toFixed(3)})`);
  }
  console.log(`Capture regression passed. Screenshots and capture: ${output}`);
} finally {
  await browser.close();
}
