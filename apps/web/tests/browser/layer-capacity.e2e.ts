import assert from "node:assert/strict";
import { test } from "./fixtures";

for (const count of [100, 1000, 5000]) {
  test(`layer virtualisation and offscreen selection (${count} nodes)`, async ({
    page,
    baseURL,
  }) => {
    const base = baseURL!;
    await page.goto(`${base}/dev/performance-preview?nodes=${count}`);
    const tree = page.getByRole("tree", { name: "Layers", exact: true });
    await tree.waitFor();
    await page
      .getByRole("button", { name: /^Zoom / })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Zoom to 100%" }).click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const { mounted, retained } = await page.locator("[data-node-id]").evaluateAll((elements) => {
      let mounted = 0,
        retained = 0;
      for (const element of elements) {
        let root: Element = element;
        let parent = root.parentElement?.closest("[data-node-id]");
        while (parent) {
          root = parent;
          parent = root.parentElement?.closest("[data-node-id]");
        }
        if (getComputedStyle(root).contentVisibility === "hidden") retained++;
        else mounted++;
      }
      return { mounted, retained };
    });
    const rows = await tree.getByRole("treeitem").count();
    assert.ok(mounted <= 300, `Only nearby frames mount at 100% (${count}: ${mounted})`);
    assert.ok(
      retained <= 4000,
      `Previously visible frames stay within the cache budget (${retained})`,
    );
    assert.ok(rows <= 100, `Layer DOM remains bounded (${count}: ${rows})`);
    if (count > 200) {
      await tree.evaluate((element) => {
        const scroller = element.closest<HTMLElement>('[role="tabpanel"]')!;
        scroller.scrollTop = scroller.scrollHeight;
      });
      await page.getByRole("button", { name: `Select Layer ${count - 1}`, exact: true }).waitFor();
      await page.getByRole("button", { name: `Select Layer ${count - 1}`, exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("textbox", { name: "Layer name", exact: true }).waitFor();
      assert.ok(
        await page.locator(`[data-node-id="layer-${count - 1}"]`).count(),
        "Offscreen selected content remains mounted",
      );
      assert.ok((await tree.getByRole("treeitem").count()) <= 100);
    }

    console.log(
      `PASS: ${count}-node editor, 100% zoom: mounted=${mounted}, layerRows=${rows}; virtual scroll and keyboard selection`,
    );
  });
}
