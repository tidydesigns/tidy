import { test, expect, required } from "./fixtures";
import { visibleColourPoint } from "./color-sampling";
import { z } from "zod";
import sharp from "sharp";
import { buildLoginDocument } from "../../lib/design/examples/login";
import { applyDocumentPatch, documentPatchSchema } from "../../lib/design/document-patch";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/privacy/mcp-analytics", (route) =>
    route.fulfill({ json: { enabled: false, signedIn: false, pending: false } }),
  );
  await page.addLocatorHandler(
    page.getByRole("button", { name: "Reject all optional", exact: true }),
    async (button) => {
      await button.click();
    },
  );
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`selection colour picker edits continuously beside the row in ${colorScheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/dev/import-preview?edit=1");
    await page
      .getByRole("button", { name: "Select Authentication panel", exact: true })
      .first()
      .click();
    const swatch = page.getByRole("button", {
      name: "Open selection colour #1e1e1e palette",
      exact: true,
    });
    await swatch.click();
    const picker = page.getByRole("dialog", { name: "Colour picker", exact: true });
    await expect(picker.getByRole("textbox", { name: "Hex colour", exact: true })).toHaveValue(
      "#1E1E1E",
    );
    const hexDraft = picker.getByRole("textbox", { name: "Hex colour", exact: true });
    await hexDraft.fill("#224466");
    await hexDraft.press("Escape");
    await expect(hexDraft).toHaveValue("#1E1E1E");
    const redDraft = picker.getByRole("spinbutton", { name: "R", exact: true });
    await redDraft.fill("128");
    await redDraft.press("Escape");
    await expect(redDraft).toHaveValue("30");
    await expect(picker).toBeVisible();
    await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
      "color",
      "rgb(30, 30, 30)",
    );
    const bounds = required(await picker.boundingBox());
    const row = required(await swatch.boundingBox());
    expect(bounds.x + bounds.width).toBeLessThan(row.x);
    const hex = picker.getByRole("textbox", { name: "Hex colour", exact: true });
    await hex.fill("#224466");
    await hex.press("Enter");
    await expect(picker).toBeVisible();
    await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
      "color",
      "rgb(34, 68, 102)",
    );
    const hue = picker.getByRole("slider", { name: "Hue", exact: true });
    await hue.focus();
    await hue.press("ArrowRight");
    await hue.press("ArrowRight");
    await expect(picker).toBeVisible();
    const square = required(
      await picker.getByRole("group", { name: "Saturation and brightness" }).boundingBox(),
    );
    await page.mouse.move(square.x + 50, square.y + 50);
    await page.mouse.down();
    await page.mouse.move(square.x + 150, square.y + 90, { steps: 8 });
    await page.mouse.up();
    await expect(picker).toBeVisible();
    const opacity = picker.getByRole("slider", { name: "Opacity", exact: true });
    await opacity.focus();
    await opacity.press("Home");
    await expect(picker.getByRole("spinbutton", { name: "Opacity %", exact: true })).toHaveValue(
      "0",
    );
    await picker.getByRole("button", { name: "Restore previous colour" }).click();
    await expect(hex).toHaveValue("#1E1E1E");
    await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
      "color",
      "rgb(30, 30, 30)",
    );
    const eyedropper = picker.getByRole("button", { name: "Pick from canvas", exact: true });
    await expect(eyedropper).toHaveText("");
    await expect(eyedropper.locator("span")).not.toHaveCSS("mask-image", /undefined/);
    await hue.focus();
    await hue.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(swatch).toBeFocused();
    await swatch.click();
    await page.getByRole("heading", { name: "Selection colours", exact: true }).click();
    await expect(picker).toHaveCount(0);
  });
}

test("eyedropper samples the canvas from a selection colour picker", async ({ page }) => {
  await page.goto("/dev/import-preview?edit=1");
  await page
    .getByRole("button", { name: "Select Authentication panel", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Open selection colour #1e1e1e palette", exact: true })
    .click();
  await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Colour picker", exact: true })).toBeVisible();
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const heading = page.locator('[data-node-id="desktop-heading"]');
  await expect(canvas).toHaveCSS("cursor", "crosshair");
  await expect(heading).toHaveCSS("cursor", "crosshair");
  const marker = page.locator("[data-canvas-color-picker-cursor]");
  const headingBox = required(await heading.boundingBox());
  const pointer = { x: headingBox.x + 10, y: headingBox.y + 5 };
  await page.mouse.move(pointer.x, pointer.y);
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAttribute("data-ready", "true");
  await expect(marker.locator("canvas")).toBeVisible();
  const markerBox = required(await marker.boundingBox());
  expect(markerBox.x).toBeCloseTo(pointer.x - 68, 0);
  expect(markerBox.y).toBeCloseTo(pointer.y > 190 ? pointer.y - 180 : pointer.y + 24, 0);
  const source = required(await page.locator('[data-node-id="desktop-screen"]').boundingBox());
  await page.mouse.click(source.x + 10, source.y + 10);
  await expect(heading).toHaveCSS("color", "rgb(242, 242, 240)");
  await expect(canvas).not.toHaveCSS("cursor", "crosshair");
  await expect(marker).toHaveCount(0);
  const picker = page.getByRole("dialog", { name: "Colour picker", exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("spinbutton", { name: "R", exact: true })).toHaveValue("242");
  await expect(picker.getByRole("spinbutton", { name: "G", exact: true })).toHaveValue("242");
  await expect(picker.getByRole("spinbutton", { name: "B", exact: true })).toHaveValue("240");
  await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  await expect(canvas).toHaveCSS("cursor", "crosshair");
  await page.keyboard.press("Escape");
  await expect(canvas).not.toHaveCSS("cursor", "crosshair");
  await expect(marker).toHaveCount(0);
});

test("sampling the visible orange beside button text picks orange rather than its transparent text box", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  await page
    .getByRole("button", { name: "Select Authentication panel", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Open selection colour #1e1e1e palette", exact: true })
    .click();
  await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  const button = required(await page.locator('[data-node-id="desktop-submit"]').boundingBox());
  await page.mouse.click(button.x + 4, button.y + button.height / 2);
  await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
    "color",
    "rgb(255, 93, 0)",
  );
});

test("merging selection colours, undoing, and editing again preserves unique rows without React errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/dev/import-preview?edit=1");
  await page
    .getByRole("button", { name: "Select Authentication panel", exact: true })
    .first()
    .click();
  const panel = page.getByLabel("Inspector", { exact: true });
  const colour = panel.getByRole("textbox", { name: "Selection colour #1e1e1e", exact: true });
  await colour.fill("#F2F2F0");
  await colour.press("Enter");
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(colour).toHaveCount(1);
  await expect(
    panel.getByRole("textbox", { name: "Selection colour #f2f2f0", exact: true }),
  ).toHaveCount(1);
  await colour.fill("#224466");
  await colour.press("Enter");
  await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
    "color",
    "rgb(34, 68, 102)",
  );
  expect(errors).toEqual([]);
});

for (const sample of [
  {
    name: "actual text glyph",
    id: "desktop-heading",
    rgb: [30, 30, 30],
    expected: "rgb(30, 30, 30)",
  },
  {
    name: "orange button fill",
    id: "desktop-submit",
    rgb: [255, 93, 0],
    expected: "rgb(255, 93, 0)",
  },
  {
    name: "transparent text-box whitespace",
    id: "desktop-heading",
    rgb: [242, 242, 240],
    expected: "rgb(242, 242, 240)",
  },
  {
    name: "input fill behind placeholder text",
    id: "desktop-email-input",
    rgb: [242, 242, 240],
    expected: "rgb(242, 242, 240)",
  },
] as const) {
  test(`eyedropper matches a visible ${sample.name} pixel and preserves the selected target`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("/dev/import-preview?edit=1");
    await page
      .getByRole("button", { name: "Select Authentication panel", exact: true })
      .first()
      .click();
    const source = page.locator(`[data-node-id="${sample.id}"]`);
    const point = await visibleColourPoint(page, source, sample.rgb);
    await page
      .getByRole("button", { name: "Open selection colour #777777 palette", exact: true })
      .click();
    await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
    await page.mouse.move(point.x, point.y);
    await expect(page.locator("[data-canvas-color-picker-cursor]")).toBeVisible();

    await expect(page.locator("[data-canvas-color-picker-cursor]")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('[data-node-id="desktop-email-placeholder"]')).toHaveCSS(
      "color",
      sample.expected,
    );
    await expect(page.locator("[data-picking-canvas-color]")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Layer name", exact: true })).toHaveValue(
      "Authentication panel",
    );
    expect(errors).toEqual([]);
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator('[data-node-id="desktop-email-placeholder"]')).toHaveCSS(
      "color",
      "rgb(119, 119, 119)",
    );
    expect(errors).toEqual([]);
  });
}

test("selecting on the canvas, opening a colour, and sampling another element preserves the target", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/dev/import-preview?edit=1");
  await page.locator('[data-node-id="desktop-heading"]').click();
  const selected = page.locator('[data-node-id][data-selected="true"]');
  await expect(selected).toHaveAttribute("data-node-id", "desktop-screen");
  const orange = await visibleColourPoint(
    page,
    page.locator('[data-node-id="desktop-submit"]'),
    [255, 93, 0],
  );
  await page
    .getByRole("button", { name: "Open selection colour #1e1e1e palette", exact: true })
    .click();
  await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  await expect(page.locator("[data-selection-controls]").first()).toHaveCSS("visibility", "hidden");
  await page.mouse.click(orange.x, orange.y);
  await expect(selected).toHaveAttribute("data-node-id", "desktop-screen");
  await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
    "color",
    "rgb(255, 93, 0)",
  );
  await expect(page.locator("[data-selection-controls]").first()).toHaveCSS(
    "visibility",
    "visible",
  );
  expect(errors).toEqual([]);
});

test("deep-selecting text on the canvas samples into that text only", async ({ page }) => {
  await page.goto("/dev/import-preview?edit=1");
  const heading = page.locator('[data-node-id="desktop-heading"]');
  await heading.click({ modifiers: ["Control"] });
  await expect(heading).toHaveAttribute("data-selected", "true");
  await expect(page.getByRole("textbox", { name: "Layer name", exact: true })).toHaveValue(
    "Welcome heading",
  );
  const orange = await visibleColourPoint(
    page,
    page.locator('[data-node-id="desktop-submit"]'),
    [255, 93, 0],
  );
  await page.getByRole("button", { name: "Open text color palette", exact: true }).click();
  await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  await page.mouse.click(orange.x, orange.y);
  await expect(heading).toHaveCSS("color", "rgb(255, 93, 0)");
  await expect(heading).toHaveAttribute("data-selected", "true");
  await expect(page.locator('[data-node-id="desktop-submit-text"]')).toHaveCSS(
    "color",
    "rgb(30, 30, 30)",
  );
  await expect(page.getByRole("textbox", { name: "Text color", exact: true })).toHaveValue(
    "#ff5d00",
  );
});

test("fully transparent text cannot steal the colour from the visible background", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  const heading = page.locator('[data-node-id="desktop-heading"]');
  await heading.click({ modifiers: ["Control"] });
  const glyph = await visibleColourPoint(page, heading, [30, 30, 30]);
  const text = page.getByRole("textbox", { name: "Text color", exact: true });
  await text.fill("#1e1e1e00");
  await text.press("Enter");
  await expect(heading).toHaveCSS("color", "rgba(30, 30, 30, 0)");
  await page
    .getByRole("button", { name: "Select Authentication panel", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Open selection colour #777777 palette", exact: true })
    .click();
  await page.getByRole("button", { name: "Pick from canvas", exact: true }).click();
  await page.mouse.click(glyph.x, glyph.y);
  await expect(page.locator('[data-node-id="desktop-email-placeholder"]')).toHaveCSS(
    "color",
    "rgb(242, 242, 240)",
  );
  await expect(heading).toHaveCSS("color", "rgba(30, 30, 30, 0)");
});

for (const selection of ["Welcome heading", "Authentication panel"] as const) {
  test(`a colour drag on ${selection} previews immediately and creates one undo step`, async ({
    page,
  }) => {
    await page.goto("/dev/import-preview?edit=1");
    await page
      .getByRole("button", { name: `Select ${selection}`, exact: true })
      .first()
      .click();
    const heading = page.locator('[data-node-id="desktop-heading"]');
    const original = await heading.evaluate((element) => getComputedStyle(element).color);
    await page
      .getByRole("button", {
        name:
          selection === "Welcome heading"
            ? "Open text color palette"
            : "Open selection colour #1e1e1e palette",
        exact: true,
      })
      .click();
    const picker = page.getByRole("dialog", { name: "Colour picker", exact: true });
    const square = required(
      await picker.getByRole("group", { name: "Saturation and brightness" }).boundingBox(),
    );
    await page.mouse.move(square.x + 25, square.y + 25);
    await page.mouse.down();
    await page.mouse.move(square.x + 150, square.y + 80, { steps: 12 });
    await expect(heading).not.toHaveCSS("color", original);
    await page.mouse.up();
    const changed = await heading.evaluate((element) => getComputedStyle(element).color);
    await picker.getByRole("button", { name: "Close colour picker", exact: true }).click();
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(heading).toHaveCSS("color", original);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(heading).toHaveCSS("color", changed);
  });
}

test("cancelling a colour drag restores its paint and switching selection cannot leak a pending preview", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  const heading = page.locator('[data-node-id="desktop-heading"]');
  const original = await heading.evaluate((element) => getComputedStyle(element).color);
  for (const interruption of ["Escape", "selection"] as const) {
    await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
    await page.getByRole("button", { name: "Open text color palette", exact: true }).click();
    const square = required(
      await page.getByRole("group", { name: "Saturation and brightness" }).boundingBox(),
    );
    await page.mouse.move(square.x + 30, square.y + 30);
    await page.mouse.down();
    await page.mouse.move(square.x + 120, square.y + 90, { steps: 5 });
    await expect(heading).not.toHaveCSS("color", original);
    if (interruption === "Escape") await page.keyboard.press("Escape");
    else
      await page
        .getByRole("button", { name: "Select Sign in button", exact: true })
        .first()
        .evaluate((button) => {
          if (button instanceof HTMLElement) button.click();
        });
    await page.mouse.up();
    await expect(heading).toHaveCSS("color", original);
    await expect(page.getByRole("dialog", { name: "Colour picker", exact: true })).toHaveCount(0);
  }
});

test("colour previews send no commits and an earlier acknowledgement preserves the next drag", async ({
  page,
}) => {
  let content = buildLoginDocument(),
    revision = 1,
    commits = 0;
  const firstAck = Promise.withResolvers<void>();
  await page.route("**/api/files/preview/presence-ticket", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/api/files/preview/changes**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          snapshot: { content, revision },
          sequence: revision,
          name: "Preview",
          canEdit: true,
        },
      });
      return;
    }
    const { patch } = z
      .object({ patch: documentPatchSchema })
      .parse(route.request().postDataJSON());
    content = applyDocumentPatch(content, patch);
    const snapshot = { content, revision: ++revision };
    if (++commits === 1) await firstAck.promise;
    await route.fulfill({ json: { snapshot, sequence: snapshot.revision, patch } });
  });
  await page.goto("/dev/import-preview?edit=1&realtime=1");
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await page.getByRole("button", { name: "Open text color palette", exact: true }).click();
  const heading = page.locator('[data-node-id="desktop-heading"]');
  const square = required(
    await page.getByRole("group", { name: "Saturation and brightness" }).boundingBox(),
  );
  await page.mouse.move(square.x + 30, square.y + 30);
  await page.mouse.down();
  await page.mouse.move(square.x + 130, square.y + 60, { steps: 8 });
  await expect(heading).not.toHaveCSS("color", "rgb(30, 30, 30)");
  expect(commits).toBe(0);
  await page.mouse.up();
  await expect.poll(() => commits).toBe(1);
  const first = await heading.evaluate((element) => getComputedStyle(element).color);
  const hue = required(await page.getByRole("slider", { name: "Hue", exact: true }).boundingBox());
  await page.mouse.move(hue.x + 20, hue.y + hue.height / 2);
  await page.mouse.down();
  await page.mouse.move(hue.x + hue.width * 0.7, hue.y + hue.height / 2, { steps: 8 });
  await expect(heading).not.toHaveCSS("color", first);
  const preview = await heading.evaluate((element) => getComputedStyle(element).color);
  const acknowledged = page.waitForResponse(
    (response) =>
      response.url().includes("/api/files/preview/changes") &&
      response.request().method() === "POST",
  );
  firstAck.resolve();
  await acknowledged;
  await expect(heading).toHaveCSS("color", preview);
  expect(commits).toBe(1);
  await page.mouse.up();
  await expect.poll(() => commits).toBe(2);
  await expect(heading).toHaveCSS("color", preview);
});

test("a page colour drag previews locally and commits exactly one undo step on release", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  const canvas = page.getByLabel("Design canvas", { exact: true });
  const original = await canvas.evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.getByRole("button", { name: "Open canvas color palette", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Colour picker", exact: true });
  const square = picker.getByRole("group", { name: "Saturation and brightness" });
  const bounds = required(await square.boundingBox());
  const marker = square.locator("span");
  const before = required(await marker.getAttribute("style"));
  await page.mouse.move(bounds.x + 30, bounds.y + 30);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 150, bounds.y + 90, { steps: 12 });
  await expect(marker).not.toHaveAttribute("style", before);
  await expect(canvas).toHaveCSS("background-color", original);
  await page.mouse.up();
  await expect(canvas).not.toHaveCSS("background-color", original);
  const changed = await canvas.evaluate((element) => getComputedStyle(element).backgroundColor);
  await picker.getByRole("button", { name: "Close colour picker", exact: true }).click();
  await canvas.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(canvas).toHaveCSS("background-color", original);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(canvas).toHaveCSS("background-color", changed);
});

for (const paint of ["gradient", "image", "vector"] as const) {
  test(`magnifier samples rendered ${paint} pixels and updates the open RGB controls`, async ({
    page,
  }) => {
    await page.goto("/dev/import-preview?edit=1");
    await page
      .getByRole("button", { name: "Select Authentication panel", exact: true })
      .first()
      .click();
    const source = page.locator('[data-node-id="desktop-submit"]');
    await source.evaluate((element, paint) => {
      if (!(element instanceof HTMLElement)) throw new Error("Missing source");
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="384" height="48"><defs><linearGradient id="sample-gradient"><stop stop-color="#224466"/><stop offset="1" stop-color="#eebb88"/></linearGradient></defs><rect width="384" height="48" fill="url(#sample-gradient)"/></svg>';
      if (paint === "gradient")
        element.style.backgroundImage = "linear-gradient(to right, #224466, #eebb88)";
      else if (paint === "vector") element.innerHTML = svg;
      else {
        const image = new Image();
        image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        image.style.cssText = "width:100%;height:100%;display:block";
        element.replaceChildren(image);
      }
    }, paint);
    const bounds = required(await source.boundingBox());
    const x = Math.floor(bounds.x + bounds.width * 0.3) + 0.5;
    const y = Math.floor(bounds.y + bounds.height * 0.5) + 0.5;
    const { data, info } = await sharp(await page.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (Math.floor(y) * info.width + Math.floor(x)) * info.channels;
    const rgb = [...data.subarray(offset, offset + 3)];
    await page
      .getByRole("button", { name: "Open selection colour #777777 palette", exact: true })
      .click();
    const picker = page.getByRole("dialog", { name: "Colour picker", exact: true });
    await picker.getByRole("button", { name: "Pick from canvas", exact: true }).click();
    const marker = page.locator("[data-canvas-color-picker-cursor]");
    await expect(marker).toHaveAttribute("data-ready", "true");
    await page.mouse.move(x, y);
    await expect(marker).toBeVisible();
    await expect(marker).toHaveText(/^#[0-9A-F]{6}$/);
    const sampled = required(await marker.textContent());
    const channels = [1, 3, 5].map((offset) => parseInt(sampled.slice(offset, offset + 2), 16));
    for (const [index, channel] of channels.entries())
      expect(Math.abs(channel - rgb[index])).toBeLessThanOrEqual(1);
    const center = await marker.locator("canvas").evaluate((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing magnifier");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Missing context");
      return [...context.getImageData(66, 66, 1, 1).data].slice(0, 3);
    });
    expect(center).toEqual(channels);
    await page.mouse.click(x, y);
    await expect(picker).toBeVisible();
    for (const [index, label] of ["R", "G", "B"].entries()) {
      await expect(picker.getByRole("spinbutton", { name: label, exact: true })).toHaveValue(
        String(channels[index]),
      );
    }
    await expect(page.locator('[data-node-id="desktop-email-placeholder"]')).toHaveCSS(
      "color",
      `rgb(${channels.join(", ")})`,
    );
  });
}

test("sampling can be toggled off, replaced by a field edit, or closed without leaking a selection", async ({
  page,
}) => {
  await page.goto("/dev/import-preview?edit=1");
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  await page.getByRole("button", { name: "Open text color palette", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Colour picker", exact: true });
  const toggle = picker.getByRole("button", { name: "Pick from canvas", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(page.locator("[data-picking-canvas-color]")).toHaveCount(0);
  await toggle.click();
  const red = picker.getByRole("spinbutton", { name: "R", exact: true });
  await red.click();
  await expect(red).toBeFocused();
  await red.fill("80");
  await red.press("Enter");
  await expect(page.locator("[data-picking-canvas-color]")).toHaveCount(0);
  await expect(page.locator('[data-node-id="desktop-heading"]')).toHaveCSS(
    "color",
    "rgb(80, 30, 30)",
  );
  await toggle.click();
  await picker.getByRole("button", { name: "Close colour picker", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator("[data-picking-canvas-color]")).toHaveCount(0);
});
