import { chromium } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exportComponent } from "../lib/design/code-export";
import { composeComponent, componentTreeSchema } from "../lib/design/compose-component";
import { buttonExample } from "../lib/mcp/design-tools";
import { strict as assert } from "node:assert";

const directory = await mkdtemp(resolve(import.meta.dir, "../.export-browser-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const iconId = "00000000-0000-4000-8000-000000000001";
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="#eeeeec" stroke-width="2"/></svg>';
  const design = composeComponent(
    componentTreeSchema.parse({
      ...buttonExample,
      widthMode: "fixed",
      heightMode: "fixed",
      box: { x: 0, y: 0, width: 300, height: 44 },
      responsiveBreakpoints: [
        { id: "00000000-0000-4000-8000-000000000002", frameMaxWidth: 250, gap: 4 },
      ],
      children: [
        {
          id: "icon",
          name: "Plus",
          type: "vector",
          assetId: iconId,
          semantics: { element: "span", hidden: true },
          widthMode: "fixed",
          heightMode: "fixed",
          box: { x: 0, y: 0, width: 16, height: 16 },
        },
        ...buttonExample.children,
      ],
    }),
  ).document;
  const output = exportComponent(design, "new-thread", "NewThread", [
    { id: iconId, mimeType: "image/svg+xml", base64: Buffer.from(svg).toString("base64") },
  ]);
  for (const file of output.files.filter((file) => file.encoding === "utf8"))
    await writeFile(resolve(directory, file.path), file.content);
  const assets = { [iconId]: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
  const entry = `import React from "react";
import { createRoot } from "react-dom/client";
import { NewThread } from "./NewThread";
import { nodeStyle } from "../lib/design/node-style";
import { resolveVariantNodes } from "../lib/design/component-variants";
import { DesignText } from "../components/design/design-text";
import { DesignImage } from "../components/design/design-image";
const doc = ${JSON.stringify(design)};
const assets = ${JSON.stringify(assets)};
function Reference({ variant }) {
  const nodes = resolveVariantNodes(doc.nodes, new Map([["new-thread", variant]]));
  function draw(node, parent) {
    const style = nodeStyle(node, parent?.layout ?? "absolute", {}, parent);
    if (!parent) { style.position = "relative"; style.left = 0; style.top = 0; }
    return <div key={node.id} style={style}>{node.type === "text" ? <DesignText node={node}/> : node.assetId ? <DesignImage node={node} src={assets[node.assetId]}/> : null}{nodes.filter(child => child.parentId === node.id).map(child => draw(child,node))}</div>;
  }
  return draw(nodes[0]);
}
const root = createRoot(document.getElementById("export"));
const reference = createRoot(document.getElementById("reference"));
window.renderExport = (text = "New thread", disabled = false, width = 300, variant = "primary") => { reference.render(<Reference variant={variant}/>); root.render(<NewThread variant={variant} assets={assets} text={{label:text}} disabled={disabled} style={{width}} onClick={() => window.clicks = (window.clicks ?? 0) + 1}/>); };
window.renderExport();`;
  await writeFile(resolve(directory, "entry.tsx"), entry);
  const result = await Bun.build({
    entrypoints: [resolve(directory, "entry.tsx")],
    target: "browser",
    format: "iife",
  });
  if (!result.success) throw new Error(result.logs.join("\n"));
  const page = await browser.newPage();
  await page.setContent(
    '<html><body style="margin:0;font-family:system-ui;font-size:16px"><div id="reference"></div><div id="export" style="margin-top:20px"></div></body></html>',
  );
  await page.addScriptTag({ content: await result.outputs[0].text() });
  await page.locator("button").waitFor();
  const geometry = () =>
    page.evaluate(() => {
      function measure(root: Element) {
        const box = root.getBoundingClientRect(),
          label = root.querySelector("[data-design-text]")!.parentElement!.getBoundingClientRect(),
          icon = root.querySelector("img")!.parentElement!.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          labelX: label.x - box.x,
          labelY: label.y - box.y,
          labelWidth: label.width,
          labelHeight: label.height,
          iconX: icon.x - box.x,
          iconY: icon.y - box.y,
        };
      }
      return {
        reference: measure(document.querySelector("#reference > div")!),
        exported: measure(document.querySelector("button")!),
      };
    });
  const baseline = await geometry();
  assert.deepEqual(
    baseline.exported,
    baseline.reference,
    "Exported control must match canvas geometry",
  );
  for (const [variant, background, hover, label] of [
    ["primary", "rgb(40, 42, 40)", "rgb(50, 76, 62)", "rgb(238, 238, 236)"],
    ["secondary", "rgb(238, 238, 236)", "rgb(221, 223, 221)", "rgb(40, 42, 40)"],
    ["danger", "rgb(143, 48, 48)", "rgb(161, 59, 59)", "rgb(238, 238, 236)"],
  ]) {
    await page.mouse.move(600, 300);
    await page.evaluate(
      (variant) =>
        (
          window as unknown as {
            renderExport: (text: string, disabled: boolean, width: number, variant: string) => void;
          }
        ).renderExport("New thread", false, 300, variant),
      variant,
    );
    await page.waitForFunction(
      (color) => getComputedStyle(document.querySelector("button")!).backgroundColor === color,
      background,
    );
    assert.deepEqual(
      (await geometry()).exported,
      (await geometry()).reference,
      `${variant} geometry matches canvas`,
    );
    assert.equal(
      await page
        .locator("button [data-design-text]")
        .evaluate((element) => getComputedStyle(element).color),
      label,
    );
    assert.equal(
      await page
        .locator("#reference > div")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      background,
    );
    await page.locator("button").hover();
    await page.waitForFunction(
      (color) => getComputedStyle(document.querySelector("button")!).backgroundColor === color,
      hover,
    );
    assert.deepEqual(
      (await geometry()).exported,
      baseline.exported,
      `${variant} hover preserves geometry`,
    );
  }
  // Switching a mounted button while hovered applies the new palette and preserves its state.
  await page.evaluate(() =>
    (
      window as unknown as {
        renderExport: (text: string, disabled: boolean, width: number, variant: string) => void;
      }
    ).renderExport("New thread", false, 300, "primary"),
  );
  await page.locator("button").hover();
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector("button")!).backgroundColor === "rgb(50, 76, 62)",
  );
  assert.deepEqual(
    (await geometry()).exported,
    baseline.exported,
    "Hover must preserve label and icon geometry",
  );
  await page.locator("button").click();
  assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 1);
  await page.mouse.move(600, 300);
  await page.locator("button").focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page.evaluate(() => (window as unknown as { clicks: number }).clicks),
    2,
    "Native keyboard activation must work",
  );
  await page.evaluate(() =>
    (
      window as unknown as {
        renderExport: (text: string, disabled: boolean, width: number) => void;
      }
    ).renderExport("Create a longer thread", false, 300),
  );
  await page.waitForFunction(
    () => document.querySelector("button")!.textContent === "Create a longer thread",
  );
  const longer = (await geometry()).exported;
  assert.ok(longer.labelWidth > baseline.exported.labelWidth);
  assert.equal(longer.labelY, baseline.exported.labelY);
  assert.ok(
    Math.abs(longer.labelX + longer.labelWidth - (longer.width - longer.iconX)) < 0.1,
    "Icon and label group stays centered",
  );
  await page.evaluate(() =>
    (
      window as unknown as {
        renderExport: (text: string, disabled: boolean, width: number) => void;
      }
    ).renderExport("New thread", true, 240),
  );
  await page.waitForFunction(
    () =>
      document.querySelector("button")!.disabled &&
      getComputedStyle(document.querySelector("button")!).columnGap === "4px",
  );
  await page.locator("button").dispatchEvent("click");
  assert.equal(
    await page.evaluate(() => (window as unknown as { clicks: number }).clicks),
    2,
    "Disabled controls do not activate",
  );
  assert.equal((await geometry()).exported.width, 240);
  await page.screenshot({ path: resolve(directory, "export-verification.png") });
  // Exercise the real inspector control, including its keyboard isolation from canvas shortcuts.
  const inspectorEntry = `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SelectionInspector } from "../app/files/[uid]/selection-inspector";
import { syncComponentEdit } from "../lib/design/component-sync";
import { resolveVariantNodes } from "../lib/design/component-variants";
import { NewThread } from "./NewThread";
const initial = ${JSON.stringify(design)};
const assets = ${JSON.stringify(assets)};
function Demo() {
  const [document, setDocument] = useState(initial);
  const selected = resolveVariantNodes(document.nodes).filter(node => node.id === "new-thread");
  return <><div id="live"><NewThread variant={document.nodes[0].variant} assets={assets}/></div>
    <SelectionInspector document={document} selected={selected} onPatch={changes => setDocument(current => ({...current, nodes:syncComponentEdit(current.nodes, "new-thread", changes)}))}
      onDocument={() => {}} onExport={() => {}} onReplaceImage={() => {}} onPrototype={() => {}} onAlign={() => {}} onDistribute={() => {}} onGroup={() => {}} /></>;
}
window.shortcuts = 0;
window.addEventListener("keydown", event => { if (event.key.startsWith("Arrow")) window.shortcuts++; });
createRoot(document.getElementById("inspector")).render(<Demo/>);`;
  await writeFile(resolve(directory, "inspector.tsx"), inspectorEntry);
  const inspectorBundle = await Bun.build({
    entrypoints: [resolve(directory, "inspector.tsx")],
    target: "browser",
    format: "iife",
  });
  assert.ok(inspectorBundle.success, inspectorBundle.logs.join("\n"));
  const inspectorPage = await browser.newPage();
  await inspectorPage.setContent('<html><body><div id="inspector"></div></body></html>');
  await inspectorPage.addScriptTag({ content: await inspectorBundle.outputs[0].text() });
  await inspectorPage
    .getByRole("button", { name: "Variant: primary", exact: true })
    .press("ArrowDown");
  await inspectorPage.getByRole("menuitemradio", { name: "danger", exact: true }).click();
  await inspectorPage.waitForFunction(
    () =>
      getComputedStyle(document.querySelector("#live button")!).backgroundColor ===
      "rgb(143, 48, 48)",
  );
  await inspectorPage
    .getByRole("button", { name: "Variant: danger", exact: true })
    .press("ArrowUp");
  await inspectorPage.getByRole("menuitemradio", { name: "danger", exact: true }).press("Home");
  await inspectorPage
    .getByRole("menuitemradio", { name: "primary", exact: true })
    .press("ArrowDown");
  await inspectorPage.getByRole("menuitemradio", { name: "secondary", exact: true }).press("Enter");
  await inspectorPage.waitForFunction(
    () =>
      getComputedStyle(document.querySelector("#live button")!).backgroundColor ===
      "rgb(238, 238, 236)",
  );
  assert.equal(
    await inspectorPage.evaluate(() => (window as unknown as { shortcuts: number }).shortcuts),
    0,
    "Variant keyboard navigation must not nudge canvas layers",
  );
  await inspectorPage.close();
  console.log(
    "Named primary/secondary/danger variants match canvas geometry and palettes; hover, longer labels, keyboard activation, disabled state, responsive sizing and inspector variant switching passed.",
  );
} finally {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
