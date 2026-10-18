import assert from "node:assert/strict";
import { test, expect, required } from "./fixtures";
declare global {
  interface Window {
    handoffCopies: string[];
    rejectCopy: boolean;
  }
}
for (const viewer of [false, true]) {
  test(`handoff inspection and clipboard behaviour (${viewer ? "viewer" : "editor"})`, async ({
    page,
    baseURL,
  }) => {
    const base = baseURL!;
    page.setDefaultTimeout(15000);
    await page.addInitScript(() => {
      window.handoffCopies = [];
      window.rejectCopy = false;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            if (window.rejectCopy) throw new Error("Clipboard denied");
            window.handoffCopies.push(text);
          },
        },
      });
    });
    await page.goto(`${base}/dev/import-preview?edit=1${viewer ? "&viewer=1" : ""}`);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.getAttribute("aria-label") === "Select Welcome heading" &&
          Object.keys(button).some((key) => key.startsWith("__reactProps")),
      ),
    );
    await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
    if (!viewer)
      await page
        .getByRole("group", { name: "Canvas mode", exact: true })
        .getByRole("button", { name: "Inspect", exact: true })
        .click();
    const inspector = page.getByLabel("Inspector", { exact: true });
    await inspector.getByRole("button", { name: "Copy CSS", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "CSS copied" }).waitFor();
    const css = required(await page.evaluate(() => window.handoffCopies.at(-1)));
    assert.equal(css, await page.getByLabel("Generated layer CSS").textContent());
    assert.ok(!css.includes("primary-orange"));
    assert.ok(css.includes("font-size:"));
    assert.ok(css.includes(":nth-child("), "text renderer markup CSS is included");
    assert.equal(
      await inspector.locator("input").count(),
      await inspector.getByRole("spinbutton", { name: "Export scale", exact: true }).count(),
      "Inspection exposes only export configuration, with no layer editing controls",
    );
    if (viewer) {
      assert.equal(await inspector.getByRole("tab").count(), 0);
      await expect(page.getByRole("group", { name: "Canvas mode" })).toHaveCount(0);
    }
    const parity = await page.evaluate((css) => {
      const source = document.querySelector<HTMLElement>('[data-node-id="desktop-heading"]')!;
      const clone = source.cloneNode(true) as HTMLElement;
      clone.removeAttribute("style");
      clone.removeAttribute("data-node-id");
      clone.classList.add("tidy-layer");
      const stylesheet = document.createElement("style");
      stylesheet.textContent = css;
      document.head.appendChild(stylesheet);
      source.parentElement!.appendChild(clone);
      const expected = getComputedStyle(source),
        actual = getComputedStyle(clone);
      const differences = [
        "width",
        "height",
        "font-size",
        "font-family",
        "font-weight",
        "line-height",
        "letter-spacing",
        "color",
        "white-space",
        "padding-top",
        "display",
      ].filter(
        (property) => expected.getPropertyValue(property) !== actual.getPropertyValue(property),
      );
      clone.remove();
      stylesheet.remove();
      return differences;
    }, css);
    assert.deepEqual(parity, []);
    await page
      .getByRole("button", { name: "Select Authentication panel", exact: true })
      .first()
      .click();
    await inspector.getByRole("button", { name: "Copy CSS", exact: true }).click();
    const panel = page.locator('[data-node-id="desktop-panel"]');
    const before = await panel.getAttribute("style");
    const canvas = page.getByLabel("Design canvas", { exact: true });
    await canvas.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Delete");
    assert.equal(
      await panel.getAttribute("style"),
      before,
      "inspection blocks nudging and deletion",
    );
    const panelCss = required(await page.evaluate(() => window.handoffCopies.at(-1)));
    assert.notEqual(panelCss, css, "Inspect mode stays active on later selections");
    assert.ok(!panelCss.includes("data-node-id"));
    await inspector.getByText("Imported source", { exact: true }).click();
    assert.ok(required(await inspector.textContent()).includes("apps/web/"));
    await page.evaluate(() => {
      window.rejectCopy = true;
    });
    await inspector.getByRole("button", { name: "Copy CSS", exact: true }).click();
    await inspector.getByRole("status").filter({ hasText: "Could not copy" }).waitFor();
    if (!viewer) {
      await canvas.click({ position: { x: 15, y: 15 } });
      await page
        .getByRole("group", { name: "Canvas mode", exact: true })
        .getByRole("button", { name: "Design", exact: true })
        .click();
      await page.getByRole("button", { name: "Rectangle tool", exact: true }).waitFor();
    }

    console.log(
      `PASS ${viewer ? "viewer" : "editor"}: CSS parity, read-only inspection, selection changes, source details and clipboard failure`,
    );
  });
}

for (const placement of ["left", "bottom"] as const) {
  test(`canvas modes preserve selection and position with ${placement} tools`, async ({ page }) => {
    await page
      .context()
      .addCookies([
        { name: "tidy-editor-toolbar", value: placement, url: "http://localhost:3391" },
      ]);
    await page.goto("/dev/import-preview?edit=1&compact=1&node=desktop-heading");
    const modes = page.getByRole("group", { name: "Canvas mode", exact: true });
    const design = modes.getByRole("button", { name: "Design", exact: true });
    const inspect = modes.getByRole("button", { name: "Inspect", exact: true });
    const canvas = page.getByLabel("Design canvas", { exact: true });
    const heading = page.locator('[data-node-id="desktop-heading"]');
    const tools = page.getByRole("toolbar", { name: "Canvas tools", exact: true });
    await expect(design).toHaveAttribute("aria-pressed", "true");
    await expect(tools).toHaveAttribute(
      "aria-orientation",
      placement === "left" ? "vertical" : "horizontal",
    );
    await heading.click();
    await expect(page.getByLabel("Inspector", { exact: true })).toBeVisible();
    const before = await heading.boundingBox();
    const commonTools = ["Select tool", "Hand tool", "Comment tool"];
    const positions = await Promise.all(
      commonTools.map((name) => tools.getByRole("button", { name, exact: true }).boundingBox()),
    );
    await inspect.click();
    await expect(inspect).toHaveAttribute("aria-pressed", "true");
    await expect(design).toBeVisible();
    await expect(tools.getByRole("button", { name: "Rectangle tool" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy CSS", exact: true })).toBeVisible();
    assert.deepEqual(await heading.boundingBox(), before, "switching does not move the canvas");
    if (placement === "left") {
      assert.deepEqual(
        await Promise.all(
          commonTools.map((name) => tools.getByRole("button", { name, exact: true }).boundingBox()),
        ),
        positions,
        "common tools keep their positions when the rail shrinks",
      );
    }
    await design.focus();
    await page.keyboard.press("Enter");
    await expect(design).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Copy CSS", exact: true })).toHaveCount(0);
    await expect(tools.getByRole("button", { name: "Rectangle tool" })).toBeVisible();
    assert.deepEqual(
      await heading.boundingBox(),
      before,
      "returning keeps the selected layer in place",
    );
    await canvas.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await heading.boundingBox())?.x).toBeGreaterThan(before!.x);

    // The exit remains available with no selection and with the panels expanded.
    await canvas.click({ position: { x: 15, y: 85 } });
    await inspect.click();
    await expect(design).toBeVisible();
    await page.getByRole("button", { name: "Expand editor panels", exact: true }).click();
    await expect(design).toBeVisible();
    await design.click();
    await expect(page.getByRole("button", { name: "Rectangle tool", exact: true })).toBeVisible();
  });
}

test("canvas mode switch stays clear of the file bar on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/dev/import-preview?edit=1&compact=1");
  const modes = page.getByRole("group", { name: "Canvas mode", exact: true });
  const fileBar = page.getByRole("link", { name: "Back to files", exact: true });
  await expect(modes).toBeVisible();
  const modeBox = required(await modes.boundingBox());
  const fileBox = required(await fileBar.boundingBox());
  assert.ok(modeBox.y > fileBox.y + fileBox.height, "the switch sits below the file bar");
  assert.ok(modeBox.x >= 0 && modeBox.x + modeBox.width <= 375);
  await modes.getByRole("button", { name: "Inspect", exact: true }).click();
  await modes.getByRole("button", { name: "Design", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rectangle tool", exact: true })).toBeVisible();
});
