import { expect, test } from "bun:test";
import {
  desktopServiceOperation,
  observeDesktopService,
  serviceMetricSchema,
} from "./service-observability";

test("functional route families discard all user-controlled paths, query values, headers and bodies", async () => {
  const rows = [
    ["GET", "account", "account"],
    ["POST", "manifest", "manifest"],
    ["GET", "organizations/PRIVATE-ORG/catalog", "catalog"],
    ["GET", "organizations/PRIVATE-ORG/files", "file_list"],
    ["POST", "organizations/PRIVATE-ORG/files", "file_create"],
    ["GET", "files/PRIVATE-FILE", "file_read"],
    ["POST", "files/PRIVATE-FILE", "file_commit"],
    ["POST", "files/PRIVATE-FILE/name", "file_rename"],
    ["GET", "files/PRIVATE-FILE/assets", "asset_read"],
    ["POST", "files/PRIVATE-FILE/assets", "asset_write"],
    ["GET", "files/PRIVATE-FILE/thumbnail", "thumbnail"],
    ["GET", "files/PRIVATE-FILE/creator-avatar", "creator_avatar"],
  ];
  for (const [method, path, operation] of rows) {
    const request = new Request(`https://example.test/api/desktop/${path}?id=PRIVATE-ASSET`, {
      method,
      headers: {
        authorization: "Bearer PRIVATE-TOKEN",
        cookie: "PRIVATE-COOKIE",
        "x-forwarded-for": "192.0.2.1",
      },
      ...(method === "POST" ? { body: "PRIVATE-DESIGN" } : {}),
    });
    let captured;
    const response = new Response("PRIVATE-RESPONSE", { status: 409 });
    expect(
      await observeDesktopService(
        request,
        async () => response,
        (value) => {
          captured = value;
        },
      ),
    ).toBe(response);
    expect(captured).toMatchObject({ operation, outcome: "conflict" });
    expect(serviceMetricSchema.safeParse(captured).success).toBe(true);
    expect(Object.keys(captured!)).toEqual(["day", "operation", "outcome", "latency"]);
    expect(JSON.stringify(captured)).not.toContain("PRIVATE");
    expect(request.bodyUsed).toBe(false);
  }
  expect(
    desktopServiceOperation(new Request("https://example.test/api/telemetry/desktop/events")),
  ).toBeUndefined();
  expect(
    desktopServiceOperation(new Request("https://example.test/api/desktop/arbitrary-secret")),
  ).toBeUndefined();
});

test("service errors keep their original behavior and never expose the exception to the metrics sink", async () => {
  const error = new Error("PRIVATE-STACK-PATH-TOKEN");
  const metrics: unknown[] = [];
  await expect(
    observeDesktopService(
      new Request("https://example.test/api/desktop/account"),
      async () => {
        throw error;
      },
      (metric) => {
        metrics.push(metric);
      },
    ),
  ).rejects.toBe(error);
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({ operation: "account", outcome: "server_error" });
  expect(JSON.stringify(metrics)).not.toContain("PRIVATE");
  const response = new Response(null, { status: 503 });
  expect(
    await observeDesktopService(
      new Request("https://example.test/api/desktop/account"),
      async () => response,
      () => {
        throw new Error("sink failed");
      },
    ),
  ).toBe(response);
});
