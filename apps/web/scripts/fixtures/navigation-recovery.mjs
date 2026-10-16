import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

async function testSiblingRecovery(context, base) {
  const build = spawnSync(
    "bun",
    [
      "build",
      fileURLToPath(new URL("./navigation-recovery-client.tsx", import.meta.url)),
      "--target=browser",
      "--define",
      'process.env={"NODE_ENV":"development"}',
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
  );
  assert.equal(build.status, 0, build.stderr);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.route(`${base}/__recovery_fixture`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<output>0</output><div id="root"></div>',
      }),
    );
    await page.goto(`${base}/__recovery_fixture`);
    await page.addScriptTag({ content: build.stdout });
    const settled = () =>
      page.waitForFunction(() =>
        ["first", "second"].every(
          (name) =>
            document.querySelector(`[data-section="${name}"]`)?.textContent === "Retry available",
        ),
      );
    await settled();
    assert.equal(await page.locator("output").textContent(), "1");
    await page.getByRole("button", { name: "Visit settings" }).click();
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "2");
    await settled();
    assert.deepEqual(errors, []);
    console.log("PASS simultaneous failed sections settle with one retry per visit in Strict Mode");
  } finally {
    await page.close();
  }
}

// Runs only inside test-navigation-browser.mjs's owned, isolated local fixture.
export async function testNavigationRecovery({ context, base, database, artifact }) {
  await testSiblingRecovery(context, base);
  const link = (page, label) =>
    page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: label, exact: true });
  const ready = async (page, path) => {
    await page.waitForURL(`${base}${path}`);
    await page.locator(`[data-page-content="${path.slice(1)}"]`).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('main [role="status"]')]
        .filter((element) => element.getClientRects().length)
        .every((element) => !/^(Loading|Retrying)/.test(element.textContent ?? "")),
    );
  };
  const page = await context.newPage();
  const unexpected = [];
  page.on("pageerror", (error) => unexpected.push(error.message));
  await page.goto(`${base}/files`);
  await page.getByRole("button", { name: /Reject optional|Use essential storage/ }).click();
  await link(page, "MCP").click();
  await ready(page, "/mcp");
  await link(page, "Settings").click();
  await ready(page, "/settings");
  const tabs = await page.getByRole("tab").allTextContents();
  await page.evaluate(() => {
    window.__sameDocument = true;
    document.querySelector("aside").dataset.persistent = "true";
    window.__frames = [];
    const observe = () => {
      window.__frames.push({
        path: location.pathname,
        title: document.title,
        skeleton: [...document.querySelectorAll("[data-page-skeleton]")].some(
          (el) => el.getClientRects().length,
        ),
        tabs: [...document.querySelectorAll('[role="tab"]')]
          .filter((el) => el.getClientRects().length)
          .map((el) => el.textContent),
      });
    };
    new MutationObserver(observe).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    observe();
  });
  const requests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).searchParams.has("_rsc")) requests.push(request.url());
  });
  for (let i = 0; i < 5; i++) {
    for (const [label, path] of [
      ["MCP", "/mcp"],
      ["Settings", "/settings"],
    ]) {
      await link(page, label).click();
      await ready(page, path);
      assert.equal(await page.title(), `${label} · Tidy`);
      assert.equal(
        await page.locator("aside[data-persistent]").getAttribute("data-persistent"),
        "true",
      );
      assert.equal(await page.evaluate(() => window.__sameDocument), true);
    }
  }
  const frames = await page.evaluate(() => window.__frames);
  assert(
    frames.every((frame) => !frame.skeleton),
    "Warm navigation displayed a page skeleton.",
  );
  assert(
    frames.every((frame) => frame.title && !frame.title.includes("127.0.0.1")),
    "Navigation cleared the title.",
  );
  assert(
    frames
      .filter((frame) => frame.tabs.length)
      .every((frame) => JSON.stringify(frame.tabs) === JSON.stringify(tabs)),
    "Settings tabs changed after first paint.",
  );
  assert.equal(requests.length, 0, "Warm MCP/Settings navigation fetched another RSC payload.");
  await page.screenshot({ path: join(artifact, "settings-warm.png") });
  console.log(
    "PASS ten warm navigations: zero RSC requests, skeletons, tab changes, title loss or sidebar remounts",
  );

  // A failed RSC prefetch is real server output, not a synthetic HTTP error.
  // Block a page dependency until pg's query timeout, then restore it BEFORE clicking.
  for (const [label, path, table, persistent, optional] of [
    ["MCP", "/mcp", "oauthConsent"],
    ["Settings", "/settings", "member"],
    ["Settings", "/settings", "billingPlan", false, true],
    ["MCP", "/mcp", "oauthConsent", true],
  ]) {
    const cold = await context.newPage();
    const lock = new pg.Client({ connectionString: database });
    await lock.connect();
    let allowPrefetch;
    const gate = new Promise((resolve) => {
      allowPrefetch = resolve;
    });
    let captured;
    const started = new Promise((resolve) => {
      captured = resolve;
    });
    let delivered;
    const prefetched = new Promise((resolve) => {
      delivered = resolve;
    });
    let first = true;
    await cold.route(
      (url) => url.pathname === path && url.searchParams.has("_rsc"),
      async (route) => {
        if (first && route.request().headers()["next-router-segment-prefetch"] !== "/_tree") {
          first = false;
          captured();
          await gate;
          const response = await route.fetch({ timeout: 30_000 });
          const payload = await response.text();
          await route.fulfill({ response, body: payload });
          delivered(payload);
        } else {
          await route.continue();
        }
      },
    );
    try {
      await cold.goto(`${base}/files`);
      await cold.getByRole("heading", { name: "Files", exact: true }).waitFor();
      await started;
      await lock.query(`begin; lock table "${table}" in access exclusive mode`);
      allowPrefetch();
      const payload = await prefetched;
      if (!optional)
        assert.match(payload, /:E\{/, `${label} fixture did not generate a server-render error.`);
      if (!persistent) await lock.query("rollback");
      const refreshes = [];
      cold.on("request", (request) => {
        if (
          new URL(request.url()).pathname === path &&
          new URL(request.url()).searchParams.has("_rsc")
        )
          refreshes.push(request.url());
      });
      await cold.evaluate(() => {
        window.__sameDocument = true;
      });
      await link(cold, label).click();
      if (optional) {
        await ready(cold, path);
        await cold.getByLabel("New password", { exact: true }).waitFor();
        assert.equal(await cold.getByRole("tab", { name: "Billing", exact: true }).count(), 0);
        await cold.getByRole("tab", { name: "Preferences", exact: true }).click();
        await cold.getByRole("heading", { name: "File editor", exact: true }).waitFor();
        assert.equal(
          refreshes.length,
          0,
          "Optional availability failure refreshed the entire page.",
        );
        assert.equal(await cold.locator("main").getByRole("alert").count(), 0);
        console.log(
          "PASS billing availability failure: Profile and Preferences usable, unavailable tab omitted, no page retry",
        );
        continue;
      }
      if (persistent) {
        const retry = cold.getByRole("button", { name: "Retry loading authorized agents" });
        await retry.waitFor();
        await cold.getByRole("heading", { name: "Connect your agent", exact: true }).waitFor();
        await cold.waitForTimeout(500);
        assert.equal(refreshes.length, 1, "Persistent outage caused a refresh loop.");
        await lock.query("rollback");
        await retry.click();
      }
      await ready(cold, path);
      await cold
        .getByRole("button", { name: /Retry loading|Try again/ })
        .waitFor({ state: "hidden" });
      assert.equal(await cold.getByRole("heading", { name: "404", exact: true }).count(), 0);
      assert.equal(await cold.evaluate(() => window.__sameDocument), true);
      assert.equal(
        refreshes.length,
        persistent ? 2 : 1,
        `${label} must recover with exactly one fresh server render.`,
      );
      await cold.screenshot({ path: join(artifact, `${label.toLowerCase()}-recovered.png`) });
      console.log(
        persistent
          ? "PASS persistent outage: static MCP instructions survive, one automatic attempt, manual retry recovers"
          : `PASS ${label}: real failed prefetch recovered automatically with one fresh request and no reload/404`,
      );
    } finally {
      allowPrefetch();
      await lock.query("rollback");
      await lock.end();
      await cold.close();
    }
  }
  // Genuine missing resources still use Next's 404 rather than outage recovery.
  const missing = await context.newPage();
  await missing.goto(`${base}/files/${crypto.randomUUID()}`);
  await missing.getByRole("heading", { name: "404", exact: true }).waitFor();
  await missing.close();
  assert.deepEqual(unexpected, [], "Successful navigation raised browser errors.");

  await page.getByRole("button", { name: "Switch organization, First workspace" }).click();
  await page.getByRole("button", { name: "Organization: First workspace", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Second workspace", exact: true }).click();
  await page.waitForURL(`${base}/files`);
  await link(page, "Settings").click();
  await ready(page, "/settings");
  await page.getByRole("tab", { name: "Organization", exact: true }).click();
  assert.equal(
    await page.getByLabel("Organization name", { exact: true }).inputValue(),
    "Second workspace",
  );
  await page.getByRole("button", { name: "Switch organization, Second workspace" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(`${base}/login`);
  await page.goBack();
  await page.waitForURL(`${base}/login`);
  assert.equal(await page.getByRole("navigation", { name: "Workspace" }).count(), 0);
  await page.close();
  console.log(
    "PASS genuine 404, organization cache invalidation, sign-out and back-button protection",
  );
}
