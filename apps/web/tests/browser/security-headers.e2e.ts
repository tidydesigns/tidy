import { expect, test } from "playwright/test";

test("application pages reject framing in the browser", async ({ page, request, baseURL }) => {
  const target = `${baseURL}/dev/import-preview?edit=1`;
  const response = await request.get(target);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-frame-options"]).toBe("DENY");

  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") violations.push(message.text());
  });
  // Even an otherwise trusted same-origin parent must not frame the app.
  // This also keeps private-network browser policy out of the assertion.
  const parent = `${baseURL}/framing-fixture`;
  await page.route(parent, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe src="${target}"></iframe>`,
    }),
  );
  await page.goto(parent);
  await expect
    .poll(() => violations.some((message) => message.includes("frame-ancestors")))
    .toBe(true);
});
