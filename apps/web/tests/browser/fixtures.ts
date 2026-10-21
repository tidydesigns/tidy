import { test as base, expect } from "playwright/test";

export const test = base.extend({
  page: async ({ page }, runFixture) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
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
    // Pixel comparisons use document pixels; the product now defaults exports
    // to 2x, so explicitly choose 1x when the export controls first appear.
    await page.addLocatorHandler(
      page
        .getByRole("spinbutton", { name: "Export scale", exact: true })
        .and(page.locator('[value="2"]')),
      async (input) => {
        await input.fill("1");
        await page.getByLabel("Export scale", { exact: true }).press("Enter");
      },
    );
    await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
    await page.route("**/__analytics/**", (route) => route.fulfill({ json: {} }));
    await page.route("https://fonts.googleapis.com/**", (route) =>
      route.fulfill({ body: "", contentType: "text/css" }),
    );
    await runFixture(page);
    expect(errors, "The browser must not report uncaught application errors").toEqual([]);
  },
});
export { expect };

export function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected a rendered element or attribute.");
  return value;
}
