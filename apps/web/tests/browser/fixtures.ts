import { test as base, expect } from "playwright/test";

export const test = base.extend({
  page: async ({ page }, runFixture) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
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
