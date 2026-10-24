import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
mock.module("server-only", () => ({}));
const { db } = await import("../db");
const {
  nativeConsent,
  captureNative,
  eraseNative,
  createAnalyticsLink,
  linkAnalyticsAccount,
  unlinkAnalyticsAccount,
  exportNative,
  maintainProductAnalytics,
} = await import("./store");
const { activityReport, retentionReport } = await import("./reports");
const { accountRetentionReport, weeklyRetentionReport, versionsReport, downloadDeltaReport } =
  await import("./reports");
const url = process.env.ANALYTICS_TEST_DATABASE_URL;
const setup = process.env.ANALYTICS_SETUP_DATABASE_URL;
const enabled =
  url &&
  setup &&
  process.env.DATABASE_URL === url &&
  new URL(url).hostname === "127.0.0.1" &&
  new URL(url).pathname === "/tidy_analytics_test" &&
  new URL(setup).hostname === "127.0.0.1" &&
  new URL(setup).pathname === "/tidy_analytics_test";
const integration = enabled ? test : test.skip;
let admin;
beforeAll(async () => {
  if (enabled) {
    admin = new Client({ connectionString: setup });
    await admin.connect();
  }
});
beforeEach(async () => {
  if (enabled) {
    await admin.query(
      'truncate "desktopAnalyticsConsent","productAnalyticsAccount","productAnalyticsEvent" cascade',
    );
    await admin.query(
      `insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ('analytics-fixture','Fixture','analytics@example.test',true,now(),now()) on conflict(id) do nothing`,
    );
  }
});
afterAll(async () => {
  if (admin) {
    await db.end();
    await admin.end();
  }
});
const event = (name, extra = {}) => ({
  id: randomUUID(),
  at: new Date().toISOString(),
  release: "0.1.0-beta.1",
  platform: "darwin",
  arch: "arm64",
  event: { name, ...extra },
});

integration(
  "guest consent gates each purpose, deduplicates deliveries, exports no credentials and erases",
  async () => {
    const receipt = await nativeConsent("", { usage: true, diagnostics: false });
    const active = event("product_active_day");
    await captureNative(receipt.token, receipt.revision, [
      active,
      active,
      event("desktop_error", { operation: "renderer", category: "unexpected" }),
    ]);
    const rows = (await db.query('select * from "productAnalyticsEvent"')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBeNull();
    const exported = await exportNative(receipt.token);
    expect(exported.events).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain(receipt.token);
    expect(JSON.stringify(exported)).not.toContain("tokenHash");
    await eraseNative(receipt.token);
    expect((await db.query('select 1 from "productAnalyticsEvent"')).rowCount).toBe(0);
    await expect(
      captureNative(receipt.token, receipt.revision, [event("product_active_day")]),
    ).rejects.toThrow();
  },
);

integration("withdrawal rejects stale revisions and removes the withdrawn purpose", async () => {
  const receipt = await nativeConsent("", { usage: true, diagnostics: true });
  await captureNative(receipt.token, 1, [
    event("product_active_day"),
    event("desktop_error", { operation: "sync", category: "unexpected" }),
  ]);
  const revoked = await nativeConsent(receipt.token, { usage: false, diagnostics: true }, 1);
  await expect(captureNative(receipt.token, 1, [event("product_active_day")])).rejects.toThrow();
  expect(revoked.revision).toBe(2);
  expect((await db.query('select purpose from "productAnalyticsEvent"')).rows).toEqual([
    { purpose: "diagnostics" },
  ]);
});

integration(
  "linking is one-time, prospective and diagnostics never inherit account identity",
  async () => {
    const receipt = await nativeConsent("", { usage: true, diagnostics: true });
    await captureNative(receipt.token, 1, [event("product_active_day")]);
    const challenge = await createAnalyticsLink(receipt.token);
    await linkAnalyticsAccount(challenge, "analytics-fixture");
    await expect(linkAnalyticsAccount(challenge, "analytics-fixture")).rejects.toThrow();
    await captureNative(receipt.token, 1, [
      event("harness_turn_started", { harness: "codex" }),
      event("desktop_error", { operation: "sync", category: "unexpected" }),
    ]);
    const rows = (
      await db.query('select name,"accountId" from "productAnalyticsEvent" order by name')
    ).rows;
    expect(rows.find((value) => value.name === "product_active_day").accountId).toBeNull();
    expect(rows.find((value) => value.name === "harness_turn_started").accountId).not.toBeNull();
    expect(rows.find((value) => value.name === "desktop_error").accountId).toBeNull();
    await unlinkAnalyticsAccount("analytics-fixture");
    expect(
      (await db.query('select name from "productAnalyticsEvent" order by name')).rows.map(
        (value) => value.name,
      ),
    ).toEqual(["desktop_error", "product_active_day"]);
    expect((await nativeConsent(receipt.token)).linked).toBe(false);
  },
);

integration(
  "expiry is excluded from reports immediately and maintenance physically deletes records",
  async () => {
    const receipt = await nativeConsent("", { usage: true, diagnostics: true });
    await captureNative(receipt.token, 1, [
      event("product_active_day"),
      event("desktop_error", { operation: "renderer", category: "unexpected" }),
    ]);
    await admin.query(`update "productAnalyticsEvent" set "expiresAt"=now()-interval '1 second'`);
    expect((await db.query(activityReport)).rows).toHaveLength(0);
    await maintainProductAnalytics();
    expect((await db.query('select 1 from "productAnalyticsEvent"')).rowCount).toBe(0);
    await admin.query(`update "desktopAnalyticsConsent" set "expiresAt"=now()-interval '1 second'`);
    await expect(captureNative(receipt.token, 1, [event("product_active_day")])).rejects.toThrow();
    await maintainProductAnalytics();
    expect((await db.query('select 1 from "desktopAnalyticsConsent"')).rowCount).toBe(0);
  },
);

integration(
  "retention counts returning installations once regardless of events per day",
  async () => {
    const receipt = await nativeConsent("", { usage: true, diagnostics: false });
    await captureNative(receipt.token, 1, [event("product_active_day")]);
    await admin.query(`update "productAnalyticsEvent" set at=now()-interval '7 days'`);
    await captureNative(receipt.token, 1, [
      event("product_active_day"),
      event("product_active_day"),
    ]);
    const rows = (await db.query(retentionReport)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].size).toBe(1);
    expect(rows[0].d7).toBe(1);
  },
);

integration("arbitrary properties cannot cross the storage boundary", async () => {
  const receipt = await nativeConsent("", { usage: true, diagnostics: true });
  await expect(
    captureNative(receipt.token, 1, [
      event("harness_turn_started", { harness: "codex", prompt: "SECRET-CANARY" }),
    ]),
  ).rejects.toThrow();
  expect((await db.query('select 1 from "productAnalyticsEvent"')).rowCount).toBe(0);
});

integration(
  "linked retention combines surfaces, weekly/versions/download queries execute under restricted role",
  async () => {
    const receipt = await nativeConsent("", { usage: true, diagnostics: false });
    await linkAnalyticsAccount(await createAnalyticsLink(receipt.token), "analytics-fixture");
    await captureNative(receipt.token, 1, [event("product_active_day")]);
    await admin.query(`update "productAnalyticsEvent" set at=now()-interval '7 days'`);
    await captureNative(receipt.token, 1, [event("product_active_day")]);
    const rows = (await db.query(accountRetentionReport)).rows;
    expect(rows[0].surface).toBe("linked_account");
    expect(rows[0].d7).toBe(1);
    expect((await db.query(weeklyRetentionReport)).rows[0].size).toBe(1);
    expect((await db.query(versionsReport)).rows[0].release).toBe("0.1.0-beta.1");
    expect((await db.query(downloadDeltaReport)).rows).toEqual([]);
  },
);

integration(
  "future timestamps and expired link challenges cannot fabricate activity or consent",
  async () => {
    const receipt = await nativeConsent("", { usage: true, diagnostics: false });
    const value = event("product_active_day");
    value.at = new Date(Date.now() + 86_400_000).toISOString();
    await captureNative(receipt.token, 1, [value]);
    expect((await db.query(activityReport)).rows).toHaveLength(0);
    const challenge = await createAnalyticsLink(receipt.token);
    await admin.query(
      `update "desktopAnalyticsConsent" set "challengeExpiresAt"=now()-interval '1 second'`,
    );
    await expect(linkAnalyticsAccount(challenge, "analytics-fixture")).rejects.toThrow();
  },
);
