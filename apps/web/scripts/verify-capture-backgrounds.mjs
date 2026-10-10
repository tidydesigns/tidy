// Standalone browser fixtures; no account, database or source website writes.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import sharp from "sharp";
import { browserCaptureScript } from "../lib/mcp/browser-capture.generated.ts";

const browser = await chromium.launch({ headless: true });
try {
  for (const fixture of [
    { html: "transparent", body: "#000", expected: "#000000" },
    { html: "transparent", body: "rgba(0,0,0,.5)", expected: "#7f7f7f" },
    { html: "#123456", body: "#000", expected: "#123456" },
    { html: "transparent", body: "transparent", expected: "#ffffff" },
  ]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.route("https://capture.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<style>html{background:${fixture.html}}body{margin:0;height:100vh;background:${fixture.body}}main{margin:auto;width:600px;height:6500px;background:#000;color:#fff}aside{position:fixed;width:180px;height:100vh;background:#000}</style><aside>Navigation</aside><main>Long scrolling profile</main>`,
      }),
    );
    await page.goto("https://capture.test/");
    await page.addScriptTag({ content: browserCaptureScript });
    const viewport = await page.evaluate(() => globalThis.__tidyCapture.prepare({}));
    const capture = await page.evaluate(
      (viewport) => globalThis.__tidyCapture.capture({ viewport }),
      viewport,
    );
    const frames = capture.document.nodes.filter((node) => node.type === "artboard");
    assert.equal(frames.length, 2, "Long pages split across artboards");
    for (const frame of frames) assert.equal(frame.style.fill, fixture.expected);
    // Check the browser's actual canvas below the viewport-height body/sidebar.
    const { data, info } = await sharp(await page.screenshot({ fullPage: true }))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (1000 * info.width + 10) * info.channels;
    const actual = `#${[...data.subarray(offset, offset + 3)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    assert.equal(actual, fixture.expected, "Artboard fill matches the rendered page canvas");
    if (fixture.html === "transparent")
      assert.ok(
        !capture.document.nodes.some((node) => node.name === "body" && node.style.fill),
        "Propagated body color is not painted twice",
      );
    await page.close();
  }
  console.log(
    "Full-page canvas backgrounds match browser pixels across viewport boundaries and artboards.",
  );
} finally {
  await browser.close();
}
