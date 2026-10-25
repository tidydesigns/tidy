import { test, expect, required } from "./fixtures";
import type { Page } from "playwright/test";
import type { CommentThread } from "@tidy/editor/design/comment-contract";

const initial = {
  id: "initial-message",
  authorId: "author",
  authorName: "Alex",
  authorImage: null,
  body: "Please increase the spacing here.",
  createdAt: "2026-10-24T15:51:00Z",
  reactions: [],
};
const thread: CommentThread = {
  id: "preview-thread",
  pageId: "page-1",
  x: 100,
  y: 100,
  createdBy: "author",
  resolved: false,
  preview: initial,
  replyCount: 8,
  messages: [initial, { ...initial, id: "reply", body: "Here is a later reply." }],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/files/preview/comments?**", (route) =>
    route.fulfill({
      json: {
        threads: [thread],
        viewerId: "author",
        reactionsAvailable: false,
        canModerateThreads: true,
        nextCursor: null,
      },
    }),
  );
});

async function openEditor(page: Page) {
  await page.goto("/dev/import-preview?edit=1&realtime=1");
  const pin = page.getByRole("button", { name: "Open comment by Alex", exact: true });
  await expect(pin).toBeVisible();
  return pin;
}

test("hover shows the initial comment without fetching and clicking the card opens replies", async ({
  page,
}) => {
  const pin = await openEditor(page);
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/comments")) reads++;
  });
  await pin.hover();
  const card = page.getByRole("button", { name: "Open thread by Alex", exact: true });
  await expect(card).toContainText(initial.body);
  await expect(card).toContainText("8 replies");
  await expect(card).not.toContainText("Here is a later reply.");
  await expect(page.getByRole("region", { name: "Comment thread", exact: true })).toHaveCount(0);
  await card.hover();
  await expect(card).toBeVisible();
  expect(reads).toBe(0);
  await card.click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Comment thread", exact: true })).toContainText(
    "Here is a later reply.",
  );
});

test("keyboard focus previews, Escape dismisses, and Enter opens the thread", async ({ page }) => {
  const pin = await openEditor(page);
  await page.keyboard.press("Tab");
  await pin.focus();
  const card = page.getByRole("button", { name: "Open thread by Alex", exact: true });
  await expect(card).toBeVisible();
  await expect(pin).toHaveAttribute("aria-describedby", /.+/);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(pin).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Comment thread", exact: true })).toBeVisible();
});

test("leaving the pin dismisses the preview and direct pin clicks open immediately", async ({
  page,
}) => {
  const pin = await openEditor(page);
  await pin.hover();
  const card = page.getByRole("button", { name: "Open thread by Alex", exact: true });
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: /^Comments \(/ }).hover();
  await expect(card).toHaveCount(0);
  await pin.click();
  await expect(page.getByRole("region", { name: "Comment thread", exact: true })).toBeVisible();
});

test("long comments stay bounded at canvas edges and resize with the viewport", async ({
  page,
}) => {
  await page.route("**/api/files/preview/comments?**", (route) =>
    route.fulfill({
      json: {
        threads: [
          {
            ...thread,
            preview: { ...initial, authorName: "Alex".repeat(80), body: "long".repeat(500) },
            replyCount: 1,
            messages: [initial],
          },
        ],
        viewerId: "author",
        reactionsAvailable: false,
        canModerateThreads: false,
      },
    }),
  );
  await page.goto("/dev/import-preview?edit=1&realtime=1");
  const pin = page.getByRole("button", { name: /^Open comment by/ });
  await expect(pin).toBeVisible();
  for (const size of [
    { width: 1100, height: 700 },
    { width: 700, height: 550 },
  ]) {
    await page.setViewportSize(size);
    const canvas = page.getByRole("region", { name: "Design canvas", exact: true });
    const bounds = required(await canvas.boundingBox());
    const pinBounds = required(await pin.boundingBox());
    await canvas.dispatchEvent("wheel", {
      deltaX: pinBounds.x + pinBounds.width / 2 - (bounds.x + bounds.width - 25),
      deltaY: pinBounds.y + pinBounds.height / 2 - (bounds.y + bounds.height - 25),
      bubbles: true,
    });
    await expect
      .poll(async () => required(await pin.boundingBox()).x)
      .toBeCloseTo(bounds.x + bounds.width - 42, 0);
    await pin.hover();
    const card = page.getByRole("button", { name: /^Open thread by/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText("1 reply");
    const rect = required(await card.boundingBox());
    expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
    expect(rect.y).toBeGreaterThanOrEqual(bounds.y);
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    expect(rect.height).toBeLessThan(200);
    await page.mouse.move(0, 0);
  }
});

test("touch opens the thread with one tap", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 1024, height: 768 },
  });
  const page = await context.newPage();
  await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
  await page.route("**/api/privacy/consent", (route) =>
    route.fulfill({
      json: {
        id: "00000000-0000-4000-8000-000000000001",
        browserId: "00000000-0000-4000-8000-000000000002",
        user: null,
      },
    }),
  );
  await page.addLocatorHandler(
    page.getByRole("button", { name: "Reject all optional", exact: true }),
    async (button) => {
      await button.click();
    },
  );
  await page.route("**/api/files/preview/comments?**", (route) =>
    route.fulfill({
      json: {
        threads: [thread],
        viewerId: "author",
        reactionsAvailable: false,
        canModerateThreads: false,
      },
    }),
  );
  try {
    const pin = await openEditor(page);
    await pin.tap();
    await expect(page.getByRole("region", { name: "Comment thread", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open thread by Alex", exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("legacy threads without preview metadata still show their first comment and omit zero replies", async ({
  page,
}) => {
  const legacy = { ...thread };
  delete legacy.preview;
  delete legacy.replyCount;
  await page.route("**/api/files/preview/comments?**", (route) =>
    route.fulfill({
      json: {
        threads: [
          { ...legacy, messages: [initial] },
          { ...thread, id: "resolved", resolved: true },
        ],
        viewerId: "author",
        reactionsAvailable: false,
        canModerateThreads: false,
      },
    }),
  );
  const pin = await openEditor(page);
  await expect(page.getByRole("button", { name: "Open comment by Alex", exact: true })).toHaveCount(
    1,
  );
  await pin.hover();
  const card = page.getByRole("button", { name: "Open thread by Alex", exact: true });
  await expect(card).toContainText(initial.body);
  await expect(card).not.toContainText(/repl(y|ies)/);
});

test("moving between nearby pins replaces a keyboard preview instead of stacking cards", async ({
  page,
}) => {
  await page.route("**/api/files/preview/comments?**", (route) =>
    route.fulfill({
      json: {
        threads: [
          thread,
          { ...thread, id: "second", x: 100, y: 400, preview: { ...initial, authorName: "Sam" } },
        ],
        viewerId: "author",
        reactionsAvailable: false,
        canModerateThreads: false,
      },
    }),
  );
  const first = await openEditor(page);
  await page.keyboard.press("Tab");
  await first.focus();
  await expect(
    page.getByRole("button", { name: "Open thread by Alex", exact: true }),
  ).toBeVisible();
  const second = page.getByRole("button", { name: "Open comment by Sam", exact: true });
  await second.hover();
  await expect(page.getByRole("button", { name: "Open thread by Alex", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Open thread by Sam", exact: true })).toBeVisible();
  await second.click();
  await expect(page.getByRole("region", { name: "Comment thread", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open thread by/ })).toHaveCount(0);
});
