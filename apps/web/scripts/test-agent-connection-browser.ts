import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "playwright/test";
import type { ConnectionStatus, NativeLogin } from "../lib/agents/protocol";

const web = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "tidy-agent-connection-"));
const initial = {
  configured: true,
  planSharingConfigured: false,
  provider: "codex",
  status: "disconnected",
  accountLabel: null,
  usageUrl: "https://example.test/usage",
  helpUrl: "https://example.test/help",
} satisfies ConnectionStatus;
const login = {
  type: "chatgptDeviceCode",
  loginId: "fixture-login",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "TEST-CODE",
} satisfies NativeLogin;

try {
  const entry = join(directory, "entry.tsx");
  await Bun.write(
    entry,
    `import { createElement } from ${JSON.stringify(join(web, "node_modules/react"))};
import { createRoot } from ${JSON.stringify(join(web, "node_modules/react-dom/client"))};
import { AgentConnectionSettings } from ${JSON.stringify(join(web, "components/agents/connection-settings"))};
createRoot(document.getElementById("root")!).render(createElement(AgentConnectionSettings, { initial: ${JSON.stringify(initial)} }));`,
  );
  const bundle = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    tsconfig: join(web, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle connection fixture");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/entry.js")
        return new Response(bundle.outputs[0], {
          headers: { "Content-Type": "text/javascript" },
        });
      return new Response(
        '<!doctype html><div id="root"></div><script type="module" src="/entry.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const outcome of [
      "server-error",
      "malformed",
      "connecting",
      "connected",
      "cancelled",
    ] as const) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const started = new Date("2026-10-17T12:00:00Z");
      await page.clock.install({ time: started });
      let polls = 0;
      await page.route("**/api/agents/connection", async (route) => {
        if (route.request().method() === "POST") return route.fulfill({ json: login });
        if (route.request().method() === "DELETE") return route.fulfill({ json: { ok: true } });
        polls++;
        if (outcome === "server-error")
          return route.fulfill({ status: 503, json: { error: "Unavailable" } });
        if (outcome === "malformed") return route.fulfill({ json: null });
        return route.fulfill({
          json: {
            ...initial,
            status: outcome === "connecting" ? "connecting" : "connected",
            accountLabel: "Fixture account",
          },
        });
      });
      await page.goto(server.url.href);
      await page.getByRole("button", { name: "Connect Codex", exact: true }).click();
      await expect(page.getByText(login.userCode, { exact: true })).toBeVisible();
      if (outcome === "cancelled") {
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(page.getByText(login.userCode, { exact: true })).toHaveCount(0);
      } else {
        await page.clock.runFor(1500);
        await expect.poll(() => polls).toBe(1);
        if (outcome === "connected") {
          await expect(page.getByText("Fixture account", { exact: true })).toBeVisible();
        } else {
          await page.clock.runFor(2500);
          await expect.poll(() => polls).toBe(2);
          await page.clock.setFixedTime(new Date(started.getTime() + 11 * 60_000));
          await page.clock.runFor(2500);
          await expect(page.getByRole("alert")).toHaveText(
            "Sign-in expired. Connect again to get a new code.",
          );
          await expect(page.getByText(login.userCode, { exact: true })).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: "Connect Codex", exact: true }),
          ).toBeEnabled();
          expect(polls).toBe(2);
        }
      }
      const stoppedAt = polls;
      await page.clock.runFor(10_000);
      expect(polls).toBe(stoppedAt);
      expect(errors).toEqual([]);
      await page.close();
      console.log(`PASS: connection polling ${outcome}`);
    }
  } finally {
    await browser.close();
    await server.stop(true);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
