// Opt-in compatibility check against the exact published nightly source and its pinned browser.
// Install the source's Effect dependencies first; no T3 user data or provider is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";
const source = process.env.T3_HTML_RENDER_SOURCE,
  executable = process.env.T3_HTML_RENDER_BROWSER;
if (!source || !executable)
  throw new Error(
    "Set T3_HTML_RENDER_SOURCE and T3_HTML_RENDER_BROWSER to the isolated compatibility checkout and pinned Chrome.",
  );
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
  "f570bd21663f56ce94c41829d3b7d72886e25a34",
);
const fromSource = (path) => import(pathToFileURL(join(source, path)).href);
const effectPath = (path) => fromSource(`node_modules/${path}`);
const Effect = await effectPath("effect/dist/Effect.js"),
  Layer = await effectPath("effect/dist/Layer.js"),
  Option = await effectPath("effect/dist/Option.js");
const NodeServices = await effectPath("@effect/platform-node/dist/NodeServices.js");
const HtmlRender = await fromSource("apps/server/src/htmlRender/HtmlRender.ts");
const PreviewBrowser = await fromSource("apps/server/src/preview/PreviewBrowser.ts");
const ServerConfig = await fromSource("apps/server/src/config.ts");
const html = await readFile(process.argv[2], "utf8");
assert.ok(Buffer.byteLength(html) <= 512000);
const output = process.argv[3];
const layer = HtmlRender.layer.pipe(
  Layer.provide(
    Layer.succeed(
      PreviewBrowser.PreviewBrowser,
      PreviewBrowser.PreviewBrowser.of({
        executable: Effect.succeed(executable),
        installed: Effect.succeed(Option.some(executable)),
      }),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "tidy-t3-html-" })),
  Layer.provideMerge(NodeServices.layer),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const renderer = yield* HtmlRender.HtmlRender;
    const previews = [];
    for (const width of [728, 390]) {
      const preview = yield* renderer.preview({ html, width });
      assert.equal(preview.width, width);
      assert.ok(preview.contentHeight > 80);
      assert.deepEqual(preview.missingImages ?? [], []);
      assert.deepEqual(
        preview.consoleMessages.filter((message) => message.level === "error"),
        [],
      );
      yield* Effect.promise(() =>
        writeFile(join(output, `t3-${width}.png`), Buffer.from(preview.png, "base64")),
      );
      previews.push({ width, contentHeight: preview.contentHeight });
    }
    const published = yield* renderer.publish({
      threadId: "tidy-local-compatibility",
      html,
      title: "Tidy compatibility",
      height: 1000,
    });
    assert.ok(published.attachmentId);
    assert.equal(published.title, "Tidy compatibility");
    assert.ok(published.heights.length >= 9);
    const prepared = yield* renderer.prepare(html);
    yield* Effect.promise(() => writeFile(join(output, "t3-prepared.html"), prepared));
    return { previews, published };
  }).pipe(Effect.provide(layer), Effect.scoped),
);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 728, height: 900 } });
  await context.setOffline(true);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(
    '<!doctype html><html><body style="margin:0"><iframe title="Tidy thread artifact" sandbox="allow-scripts allow-forms" style="border:0;width:100%;height:800px"></iframe></body></html>',
  );
  await page.evaluate(
    (prepared) => {
      window.tidyTestSecret = "host-only-fixture";
      window.tidyHeightMessages = [];
      window.addEventListener("message", (event) => {
        if (typeof event.data?.params?.height === "number")
          window.tidyHeightMessages.push(event.data.params.height);
      });
      document.querySelector("iframe").srcdoc = prepared;
    },
    await readFile(join(output, "t3-prepared.html"), "utf8"),
  );
  const frame = page.frameLocator("iframe");
  await frame.locator("[data-tidy-design] > *").waitFor();
  await frame.getByRole("button", { name: "Payment button", exact: true }).click();
  await frame.getByRole("button", { name: "secondary", exact: true }).click();
  await frame.getByText("Continue instead", { exact: true }).waitFor();
  const nested = page.frames().find((item) => item.parentFrame());
  assert.equal(
    await nested.evaluate(() => {
      try {
        return parent.tidyTestSecret !== undefined;
      } catch {
        return false;
      }
    }),
    false,
  );
  await page.waitForFunction(() => window.tidyHeightMessages.length > 0);
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(
    await nested.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log(
  "PASS: T3 v0.0.46-nightly.20261007.2787 preview screenshots, measured publication, opaque iframe controls and bootstrap",
  JSON.stringify(result.previews),
);
