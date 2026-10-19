import { expect, mock, test } from "bun:test";
import { runScheduledMaintenance } from "./scheduled-maintenance";

test("maintenance tasks run independently and billing remains optional", async () => {
  const paths: string[] = [];
  const fetch = mock(async (request: Request) => {
    paths.push(new URL(request.url).pathname);
    expect(request.headers.get("authorization")).toBe(`Bearer ${"a".repeat(32)}`);
    return new Response(null);
  });
  const env = {
    PRIVACY_CLEANUP_SECRET: "a".repeat(32),
    WORKER_SELF_REFERENCE: { fetch } as unknown as Fetcher,
  };
  await runScheduledMaintenance(env);
  expect(paths).toEqual(["/api/privacy/cleanup"]);
  paths.length = 0;
  await runScheduledMaintenance({ ...env, BILLING_RECONCILIATION_SECRET: "a".repeat(32) });
  expect(paths).toEqual(["/api/privacy/cleanup", "/api/internal/billing/reconcile"]);
  paths.length = 0;
  await expect(
    runScheduledMaintenance({
      ...env,
      PRIVACY_CLEANUP_SECRET: "",
      BILLING_RECONCILIATION_SECRET: "a".repeat(32),
    }),
  ).rejects.toThrow();
  expect(paths).toEqual(["/api/internal/billing/reconcile"]);
});

test("failed maintenance responses are surfaced without response content", async () => {
  const env = {
    PRIVACY_CLEANUP_SECRET: "a".repeat(32),
    WORKER_SELF_REFERENCE: {
      fetch: async () => new Response("private provider detail", { status: 503 }),
    } as unknown as Fetcher,
  };
  await expect(runScheduledMaintenance(env)).rejects.toThrow(
    "Scheduled maintenance did not complete.",
  );
});
