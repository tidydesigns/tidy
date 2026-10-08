import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
const base = process.env.LIBRARIES_TEST_BASE_URL ?? "http://localhost:3037";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Library browser checks require localhost.");
const source = JSON.parse(
  execFileSync("bun", ["scripts/fixtures/component-library-source.ts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  }),
);
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let unavailable = false;
await page.route("**/api/files/00000000-0000-4000-8000-000000000037/snapshot", (route) =>
  route.fulfill({
    status: unavailable ? 404 : 200,
    contentType: "application/json",
    body: unavailable ? "{}" : JSON.stringify(source),
  }),
);
const select = (name) => page.getByRole("button", { name: `Select ${name}`, exact: true }).click();
const commit = async (label, value) => {
  await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel(label, { exact: true }).press("Enter");
};
try {
  await page.goto(`${base}/dev/import-preview?edit=1&libraries=1`);
  await page.waitForSelector('[data-node-id="linked-instance"]');
  await select("Library button instance");
  await commit("Label", "Custom");
  assert.ok((await page.locator('[data-node-id="linked-label"]').textContent()).includes("Custom"));
  await page.getByRole("button", { name: /^Variant:/ }).click();
  await page.getByRole("menuitemradio", { name: "compact", exact: true }).click();
  assert.ok((await page.locator('[data-node-id="linked-label"]').textContent()).includes("Custom"));
  await page.getByText("Components · 2", { exact: true }).click();
  await page.getByRole("button", { name: "Check updates", exact: true }).click();
  await page.getByText("Revision 1 · Revision 2 available", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Apply update", exact: true }).click();
  await page.getByText("Revision 2 · Linked source", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Label size", { exact: true }).inputValue(), "24");
  assert.ok((await page.locator('[data-node-id="linked-label"]').textContent()).includes("Custom"));
  await page.keyboard.press("Meta+z");
  await page.getByText("Revision 1 · Revision 2 available", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Label size", { exact: true }).inputValue(), "18");
  await page.getByRole("button", { name: "Apply update", exact: true }).click();
  await page.getByText("Revision 2 · Linked source", { exact: true }).waitFor();
  unavailable = true;
  await page.getByRole("button", { name: "Check updates", exact: true }).click();
  await page
    .getByText("Revision 2 · Source unavailable; using cached component", { exact: true })
    .waitFor();
  assert.ok((await page.locator('[data-node-id="linked-label"]').textContent()).includes("Custom"));
  unavailable = false;
  await page.getByRole("button", { name: "Link library", exact: true }).click();
  await commit("Source file URL or ID", "00000000-0000-4000-8000-000000000037");
  await page.getByRole("button", { name: "Find components", exact: true }).click();
  await page
    .getByRole("button", { name: "Library component: Library button", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Link component", exact: true }).click();
  await page.getByText("Revision 2 · Linked source", { exact: true }).waitFor();
  assert.ok((await page.locator('[data-node-id="linked-label"]').textContent()).includes("Custom"));
  await select("Local button");
  await commit("Property name", "Button width");
  await page.getByRole("button", { name: /^Property: visible$/ }).click();
  await page.getByRole("menuitemradio", { name: "width", exact: true }).click();
  await page.getByRole("button", { name: "Expose property", exact: true }).click();
  await commit("Button width", "200");
  assert.equal(await page.getByLabel("Width", { exact: true }).inputValue(), "200");
  await page.keyboard.press("Meta+z");
  assert.equal(await page.getByLabel("Button width", { exact: true }).inputValue(), "180");
  await select("Local label");
  await page.getByText("Create reusable style", { exact: true }).click();
  await commit("Style name", "Caption");
  await page.getByRole("button", { name: "Create style", exact: true }).click();
  await page.getByRole("button", { name: "Reusable style: Caption", exact: true }).waitFor();
  await commit("Font size", "22");
  await page.getByRole("button", { name: "Update style from layer", exact: true }).click();
  await page.getByRole("button", { name: "Reset style overrides", exact: true }).click();
  assert.equal(await page.getByLabel("Font size", { exact: true }).inputValue(), "22");
  await page.getByRole("button", { name: "Delete style", exact: true }).click();
  assert.equal(await page.getByLabel("Font size", { exact: true }).inputValue(), "22");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: linked update/unavailable/undo, variants with overrides, exposed property authoring, reusable styles",
  );
} finally {
  await browser.close();
}
