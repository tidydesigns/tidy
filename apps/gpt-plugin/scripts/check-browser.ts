import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const browser = await chromium.launch({ headless: true });
const artifacts = resolve(import.meta.dir, "../../../.artifacts/gpt-plugin");
await mkdir(artifacts, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${process.env.GPT_PLUGIN_PORT ?? 3102}/`);
  const widget = page.frameLocator("#widget");
  await widget.getByText("Make room for your ideas").waitFor();
  await widget.getByRole("button", { name: "Frame: Welcome" }).click();
  await widget.getByRole("menuitemradio", { name: "Profile" }).click();
  await widget.getByText("Your workspace").waitFor();
  await page.locator("#status").filter({ hasText: "Selected Tidy design root profile" }).waitFor();
  await page.getByRole("button", { name: "Simulate model edit" }).click();
  assert.equal(
    await widget.getByRole("button", { name: "Frame: Profile" }).count(),
    1,
    "Model edits preserve frame selection",
  );
  await widget.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Read revision 2.").waitFor();
  await widget.getByRole("button", { name: "Open in Tidy" }).click();
  await page
    .getByText("Open https://app.tidydesign.co/files/local-preview", { exact: true })
    .waitFor();
  await widget.getByRole("button", { name: "Frame: Profile" }).click();
  await widget.getByRole("menuitemradio", { name: "Welcome" }).click();
  await widget.getByText("A new idea, revision 2").waitFor();
  await page.screenshot({ path: resolve(artifacts, "desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Toggle theme" }).click();
  const frame = page.frames().find((frame) => frame.url().endsWith("/widget"))!;
  await frame.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.screenshot({ path: resolve(artifacts, "dark.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 850 });
  await page.screenshot({ path: resolve(artifacts, "mobile.png"), fullPage: true });
  assert.equal(
    await frame.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    "No horizontal overflow on mobile",
  );
  // A component with hug sizing must be measured rather than rendered at its stored 1px fallback.
  await page.evaluate(async () => {
    const preview = await (await fetch("/fixture")).json();
    preview.fileId = "component";
    preview.url = "https://app.tidydesign.co/files/component";
    preview.roots = [{ id: "welcome", name: "Component", pageId: "page-1", width: 1, height: 1 }];
    preview.document.nodes = preview.document.nodes.filter(
      (node: { id: string; parentId: string | null }) =>
        node.id === "welcome" || node.parentId === "welcome",
    );
    preview.document.nodes[0].type = "container";
    preview.document.nodes[0].widthMode = "hug";
    preview.document.nodes[0].heightMode = "hug";
    preview.document.nodes[0].box.width = 1;
    preview.document.nodes[0].box.height = 1;
    preview.document.nodes[1].widthMode = "hug";
    preview.document.nodes[2].widthMode = "hug";
    document.querySelector<HTMLIFrameElement>("#widget")!.contentWindow!.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { _meta: { tidyPreview: preview } },
      },
      location.origin,
    );
  });
  await widget.getByText("Make room for your ideas").waitFor();
  await frame.waitForFunction(
    () => (document.querySelector(".scaled") as HTMLElement)?.offsetWidth > 100,
  );
  // Host data is escaped by React, and refresh errors remain visible without losing the preview.
  await page.evaluate(() =>
    document.querySelector<HTMLIFrameElement>("#widget")!.contentWindow!.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { isError: true, content: [{ type: "text", text: "File access ended." }] },
      },
      location.origin,
    ),
  );
  await widget.getByRole("alert").getByText("File access ended.").waitFor();
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log(`Plugin browser checks passed. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
