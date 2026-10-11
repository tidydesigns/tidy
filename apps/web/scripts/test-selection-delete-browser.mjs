import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// Runs in the page so the same checks can use the collaborative preview browser.
export async function checkSelectionDeletion(vector = false) {
  const results = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    results.push(message);
  };
  const settle = async () => {
    await new Promise((resolve) => {
      // Background collaborative tabs can suspend animation frames.
      const fallback = setTimeout(resolve, 100);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(fallback);
          resolve();
        }),
      );
    });
    // Panel width transitions move the canvas centre. Wait before measuring a
    // marquee rather than selecting against coordinates from mid-animation.
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    );
  };
  const canvas = document.querySelector('[aria-label="Design canvas"]');
  const nodes = () => [...canvas.querySelectorAll("[data-node-id]")];
  const selected = () => nodes().filter((node) => node.dataset.selected === "true");
  const key = async (key, metaKey = false) => {
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key, metaKey, bubbles: true, cancelable: true }),
    );
    await settle();
  };
  const button = (label) => document.querySelector(`button[aria-label="${label}"]`);
  const select = async (label, shiftKey = false) => {
    button(`Select ${label}`).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
    canvas.focus();
    await settle();
  };
  const menu = async (element, point) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: point?.x ?? rect.x + 5,
        clientY: point?.y ?? rect.y + 5,
      }),
    );
    await settle();
  };
  const deleteFromMenu = async () => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent.startsWith("Delete"),
    );
    check(item && !item.disabled, "Delete is available for the selection");
    item.click();
    await settle();
  };
  const marquee = async (rect) => {
    // Synthetic pointer events have no native pointer to capture.
    const capture = canvas.setPointerCapture;
    canvas.setPointerCapture = () => {};
    try {
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: rect.x - 8,
          clientY: rect.y - 8,
        }),
      );
      await settle();
      canvas.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: rect.right + 8,
          clientY: rect.bottom + 8,
        }),
      );
      await settle();
    } finally {
      canvas.setPointerCapture = capture;
    }
  };
  const count = nodes().length;

  if (vector) {
    await select("Editable path");
    [...document.querySelectorAll("button")]
      .find((item) => item.textContent === "Edit points")
      .click();
    await settle();
    check(!!document.querySelector("[data-vector-editor]"), "Vector editing starts");
    await marquee(canvas.querySelector('[data-node-id="frame"]').getBoundingClientRect());
    check(selected().length === count, "Marquee selects the frame and its vector descendants");
    check(!document.querySelector("[data-vector-editor]"), "Marquee exits vector editing");
    await key("Backspace");
    check(nodes().length === 0, "Backspace deletes the selection after vector editing");
    await key("z", true);
    check(nodes().length === count, "Undo restores the whole vector selection");
    return results;
  }

  const desktop = "Desktop 1440 · /login";
  const mobile = "Mobile 390 · /login";
  await select(desktop);
  await select(mobile, true);
  const dragged = canvas.querySelector('[data-node-id="desktop-screen"]');
  const beforeDrag = dragged.getBoundingClientRect();
  const capture = canvas.setPointerCapture;
  canvas.setPointerCapture = () => {};
  try {
    dragged.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX: beforeDrag.x + 10,
        clientY: beforeDrag.y + 10,
      }),
    );
    await settle();
    canvas.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: beforeDrag.x + 30,
        clientY: beforeDrag.y + 30,
      }),
    );
    await settle();
  } finally {
    canvas.setPointerCapture = capture;
  }
  check(
    selected().length === 2 && dragged.getBoundingClientRect().x !== beforeDrag.x,
    "Dragging multiple frames preserves the selection",
  );
  await key("Backspace");
  check(nodes().length === 0, "Backspace works immediately after dragging multiple frames");
  await key("z", true);
  await menu(canvas.querySelector('[data-node-id="desktop-logo"]'));
  check(selected().length === 2, "Right-clicking a selected frame's child preserves both frames");
  await deleteFromMenu();
  check(nodes().length === 0, "Menu Delete removes both frames and all descendants");
  await key("z", true);
  check(
    nodes().length === count && selected().length === 2,
    "One undo restores all deleted layers and the selection",
  );
  await menu(button(`Select ${desktop}`));
  await deleteFromMenu();
  check(nodes().length === 0, "Layer-list menu Delete also removes the full selection");
  await key("z", true);

  const first = canvas.querySelector('[data-node-id="desktop-screen"]').getBoundingClientRect();
  const second = canvas.querySelector('[data-node-id="mobile-screen"]').getBoundingClientRect();
  await menu(canvas, { x: (first.right + second.left) / 2, y: first.y + 20 });
  await deleteFromMenu();
  check(nodes().length === 0, "Menu Delete works in the gap between selected frames");
  await key("z", true);

  await select(desktop);
  await menu(canvas.querySelector('[data-node-id="mobile-screen"]'));
  await deleteFromMenu();
  check(
    !!canvas.querySelector('[data-node-id="desktop-screen"]') &&
      !canvas.querySelector('[data-node-id="mobile-screen"]'),
    "Right-clicking an unrelated frame only deletes that frame",
  );
  await key("z", true);

  canvas.focus();
  await key("Escape");
  await marquee(canvas.querySelector('[data-node-id="desktop-screen"]').getBoundingClientRect());
  check(selected().length > 1, "Marquee includes the frame and its children");
  await key("Backspace");
  check(
    !canvas.querySelector('[data-node-id="desktop-screen"]') &&
      !!canvas.querySelector('[data-node-id="mobile-screen"]'),
    "Backspace deletes the marquee selection and preserves unrelated frames",
  );
  await key("z", true);
  await key("Delete");
  check(
    !canvas.querySelector('[data-node-id="desktop-screen"]'),
    "Delete uses the same multi-selection action",
  );
  await key("z", true);

  const search = document.querySelector('input[aria-label="Search layers"]');
  search.focus();
  await key("Backspace");
  check(nodes().length === count, "Backspace in an input does not delete canvas layers");
  canvas.focus();
  await select(desktop);
  await select(mobile, true);
  button(`Lock ${mobile}`).click();
  await settle();
  await menu(canvas.querySelector('[data-node-id="desktop-screen"]'));
  const deleteItem = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.textContent.startsWith("Delete"),
  );
  check(deleteItem.disabled, "Menu Delete respects every selected layer's lock");
  await key("Escape");
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env.SELECTION_TEST_BASE_URL ?? "http://localhost:3045";
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Use a localhost app");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1536, height: 960 } });
    for (const scenario of ["", "&vector=1", "&captureHistory=1"]) {
      const vector = scenario === "&vector=1";
      await page.goto(`${base}/dev/import-preview?edit=1${scenario}`);
      await page.waitForSelector("[data-node-id]");
      console.log(scenario || "standard", await page.evaluate(checkSelectionDeletion, vector));
      assert.deepEqual(
        (await page.locator('[role="alert"]').allTextContents()).filter((text) => text.trim()),
        [],
        "No editor error is shown",
      );
    }
  } finally {
    await browser.close();
  }
}
