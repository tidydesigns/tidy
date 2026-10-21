import { expect, test } from "playwright/test";

const receipt = {
  id: "00000000-0000-4000-8000-000000000001",
  browserId: "00000000-0000-4000-8000-000000000002",
  user: null,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/privacy/consent", (route) => route.fulfill({ json: receipt }));
  await page.route("**/api/privacy/mcp-analytics", (route) =>
    route.fulfill({ json: { enabled: false, signedIn: false } }),
  );
});

test("modal content scrolls without moving the page, and every dismissal unlocks it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto("/reset-password?token=privacy-fixture");
  const dialog = page.getByRole("dialog", { name: "Privacy choices", exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (document.body.style.minHeight = "3000px"));
  await expect(page.locator("html")).toHaveCSS("overflow-y", "hidden");
  await expect(page.locator("body")).toHaveCSS("overflow-y", "hidden");
  await dialog.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.mouse.wheel(0, 2000);
  await page.mouse.move(2, 2);
  await page.mouse.wheel(0, 500);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  for (const dismiss of ["escape", "button", "backdrop"] as const) {
    if (dismiss === "escape") await page.keyboard.press("Escape");
    else if (dismiss === "button")
      await page.getByRole("button", { name: "Close privacy choices", exact: true }).click();
    else await page.mouse.click(2, 2);
    await expect(dialog).toBeHidden();
    await expect(page.locator("html")).not.toHaveCSS("overflow-y", "hidden");
    await page.mouse.move(100, 100);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(page.locator("html")).toHaveCSS("overflow-y", "hidden");
  }
});

for (const action of ["Accept all optional", "Reject all optional"]) {
  test(`${action} closes synchronously while both confirmations are blocked`, async ({ page }) => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/privacy/consent", async (route) => {
      await blocked;
      await route.fulfill({ json: receipt });
    });
    await page.route("**/api/privacy/mcp-analytics", async (route) => {
      if (route.request().method() === "POST") await blocked;
      await route.fulfill({ json: { enabled: action === "Accept all optional" } });
    });
    await page.goto("/reset-password?token=privacy-fixture");
    const dialog = page.getByRole("dialog", { name: "Privacy choices", exact: true });
    await expect(dialog).toBeVisible();
    // Read open in the same task as the click: no polling or server completion.
    expect(
      await page.getByRole("button", { name: action, exact: true }).evaluate((button) => {
        (button as HTMLButtonElement).click();
        return (document.getElementById("privacy-choices-dialog") as HTMLDialogElement).open;
      }),
    ).toBe(false);
    await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
    await expect(dialog).toBeVisible();
    const mcp = page.getByRole("button", { name: /^Account-linked MCP diagnostics:/ });
    await expect(mcp).toBeEnabled();
    await expect(mcp).toContainText(action === "Accept all optional" ? "On" : "Off");
    release();
    await expect(dialog).toBeVisible();
  });
}

test("rapid choices persist in order and stale responses do not undo the next interaction", async ({
  page,
}) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const writes: boolean[] = [];
  await page.route("**/api/privacy/mcp-analytics", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ json: { enabled: false } });
      return;
    }
    const { enabled } = route.request().postDataJSON();
    writes.push(enabled);
    if (writes.length === 1) await blocked;
    await route.fulfill({ json: { enabled } });
  });
  await page.goto("/reset-password?token=privacy-fixture");
  await page.getByRole("button", { name: "Accept all optional", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  await page.getByRole("button", { name: "Reject all optional", exact: true }).click();
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  const mcp = page.getByRole("button", { name: /^Account-linked MCP diagnostics:/ });
  await expect(mcp).toBeEnabled();
  await expect(mcp).toContainText("Off");
  expect(writes).toEqual([true]);
  release();
  await expect.poll(() => writes).toEqual([true, false]);
  await expect(mcp).toContainText("Off");
  await expect(page.getByRole("dialog", { name: "Privacy choices", exact: true })).toBeVisible();
});

test("a queued withdrawal is replayed after reloading during an earlier opt-in", async ({
  page,
}) => {
  // LAN HTTP contexts can provide crypto without randomUUID.
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const writes: boolean[] = [];
  let serverEnabled = false;
  await page.route("**/api/privacy/mcp-analytics", async (route) => {
    if (route.request().method() === "POST") {
      const { enabled } = route.request().postDataJSON();
      writes.push(enabled);
      serverEnabled = enabled;
      if (enabled) await blocked;
      await route.fulfill({ json: { enabled } }).catch(() => {});
    } else await route.fulfill({ json: { enabled: serverEnabled } });
  });
  await page.goto("/reset-password?token=privacy-fixture");
  await page.getByRole("button", { name: "Accept all optional", exact: true }).click();
  await expect.poll(() => writes).toEqual([true]);
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  await page.getByRole("button", { name: "Reject all optional", exact: true }).click();
  expect(writes).toEqual([true]);
  await page.reload();
  await expect.poll(() => writes).toEqual([true, false]);
  expect(serverEnabled).toBe(false);
  release();
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  const mcp = page.getByRole("button", { name: /^Account-linked MCP diagnostics:/ });
  await expect(mcp).toBeEnabled();
  await expect(mcp).toContainText("Off");
  await page.reload();
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  await expect(mcp).toBeEnabled();
  await expect(mcp).toContainText("Off");
  expect(writes).toEqual([true, false]);
});

test("an unconfirmed withdrawal survives repeated reloads and remains retryable", async ({
  page,
}) => {
  let fail = true;
  let writes = 0;
  await page.route("**/api/privacy/mcp-analytics", (route) => {
    if (route.request().method() === "POST") {
      writes++;
      return route.fulfill(fail ? { status: 503, json: {} } : { json: { enabled: false } });
    }
    return route.fulfill({ json: { enabled: false } });
  });
  await page.goto("/reset-password?token=privacy-fixture");
  await page.getByRole("button", { name: "Reject all optional", exact: true }).click();
  const notice = page.getByRole("complementary", { name: "Privacy choices" }).getByRole("alert");
  await expect(notice).toContainText("server confirmation is pending");
  expect(writes).toBe(1);
  await page.reload();
  await expect(notice).toContainText("server confirmation is pending");
  expect(writes).toBe(2);
  fail = false;
  await notice.getByRole("button", { name: "Retry recording choice", exact: true }).click();
  await expect.poll(() => writes).toBe(3);
  await expect(notice).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^Account-linked MCP diagnostics:/ }),
  ).toBeEnabled();
  expect(writes).toBe(3);
});

test("returning to the tab preserves an unconfirmed MCP selection for retry", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/privacy/mcp-analytics", (route) => {
    if (route.request().method() === "POST") return route.fulfill({ status: 503, json: {} });
    reads++;
    return route.fulfill({ json: { enabled: false } });
  });
  await page.goto("/reset-password?token=privacy-fixture");
  await page.getByRole("button", { name: "Choose individually", exact: true }).click();
  const mcp = page.getByRole("button", { name: /^Account-linked MCP diagnostics:/ });
  await expect(mcp).toBeEnabled();
  await expect(mcp).toContainText("Off");
  await mcp.click();
  await page.getByRole("menuitemradio", { name: "On", exact: true }).click();
  const notice = page
    .getByRole("dialog", { name: "Privacy choices", exact: true })
    .getByRole("status");
  await expect(notice).toContainText("server confirmation is pending");
  const initialReads = reads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(mcp).toBeEnabled();
  await expect(mcp).toContainText("On");
  await expect(
    page.getByRole("button", { name: "Retry recording choice", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Privacy choices" }).getByRole("alert"),
  ).toHaveCount(0);
  expect(reads).toBe(initialReads);
});

test("failed confirmation stays dismissed and offers a background retry", async ({ page }) => {
  let fail = true;
  await page.route("**/api/privacy/mcp-analytics", (route) =>
    route.fulfill(
      route.request().method() === "POST" && fail
        ? { status: 503, json: {} }
        : { json: { enabled: false } },
    ),
  );
  await page.goto("/reset-password?token=privacy-fixture");
  await page.getByRole("button", { name: "Reject all optional", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Privacy choices", exact: true });
  await expect(dialog).toBeHidden();
  const notice = page.getByRole("complementary", { name: "Privacy choices" }).getByRole("alert");
  await expect(notice).toContainText("server confirmation is pending");
  fail = false;
  await notice.getByRole("button", { name: "Retry recording choice", exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(dialog).toBeHidden();

  fail = true;
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  await page.getByRole("button", { name: "Reject all optional", exact: true }).click();
  await expect(notice).toContainText("server confirmation is pending");
  await notice.getByRole("button", { name: "Dismiss notification", exact: true }).click();
  await expect(notice).toBeHidden();
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Retry recording choice" })).toHaveCount(0);
});
