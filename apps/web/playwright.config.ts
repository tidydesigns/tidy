import { defineConfig } from "playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 3391;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: process.env.BROWSER_TEST_ARTIFACTS ?? join(tmpdir(), "tidy-browser-results"),
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bun run dev --port ${port}`,
    url: `${baseURL}/dev/import-preview?edit=1`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/browser_tests",
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: "disposable-browser-fixture-secret-never-used-in-production",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_POSTHOG_KEY: "",
      POSTHOG_API_KEY: "",
      POSTHOG_UPLOAD_SOURCEMAPS: "0",
      TIDY_AGENTS_ENABLED: "false",
    },
  },
});
