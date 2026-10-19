import { test, expect } from "./fixtures";

for (const selection of [
  { id: "frame-0", name: "Component master", captionId: "layer-3" },
  {
    id: "component-instance-0",
    name: "Component master instance",
    captionId: "component-instance-3",
  },
]) {
  test(`panning ${selection.name} leaves the inspector unchanged and its fields editable`, async ({
    page,
  }) => {
    await page.goto("/dev/performance-preview?nodes=1000&components=1");
    await page.getByRole("textbox", { name: "Search layers", exact: true }).fill("component");
    await page.getByRole("button", { name: `Select ${selection.name}`, exact: true }).click();
    const canvas = page.getByRole("region", { name: "Design canvas", exact: true });
    await canvas.focus();
    await page.keyboard.press("Shift+2");
    const name = page.getByRole("textbox", { name: "Layer name", exact: true });
    await expect(name).toHaveValue(selection.name);
    await expect(page.getByRole("textbox", { name: "Caption", exact: true })).toHaveValue("Text 3");
    await page.waitForTimeout(500);
    const result = await canvas.evaluate(async (element, id) => {
      const inspector = document.querySelector('[data-kind="inspector"]');
      const artwork = document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)?.parentElement;
      if (!inspector || !artwork) throw new Error("Missing inspector or artwork");
      const before = artwork.style.transform;
      let mutations = 0;
      const observer = new MutationObserver((records) => (mutations += records.length));
      observer.observe(inspector, { subtree: true, childList: true, attributes: true });
      for (let index = 0; index < 12; index++) {
        element.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 4 }),
        );
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      }
      observer.disconnect();
      return { before, after: artwork.style.transform, mutations };
    }, selection.id);
    expect(result.after).not.toBe(result.before);
    expect(result.mutations).toBe(0);
    await name.fill("Updated component");
    await name.press("Enter");
    await expect(
      page
        .locator(`[data-layer-row="${selection.id}"]`)
        .getByRole("button", { name: "Select Updated component", exact: true }),
    ).toBeVisible();
    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect(name).toHaveValue(selection.name);
    const caption = page.getByRole("textbox", { name: "Caption", exact: true });
    await caption.fill("Updated caption");
    await caption.press("Enter");
    await expect(page.locator(`[data-node-id="${selection.captionId}"]`)).toHaveText(
      "Updated caption",
    );
    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect(caption).toHaveValue("Text 3");
  });
}
