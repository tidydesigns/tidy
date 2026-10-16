import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("Linear response boundaries reject malformed data and preserve error mapping without retrying", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    import { z } from "zod";
    mock.module("server-only", () => ({}));
    const { linearRequest, parseLinearResponse } = await import("./lib/linear/client.ts");
    let data = null, calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json(data); };
    const issue = z.object({ issue: z.object({ team: z.object({ id: z.string() }) }).nullable() });
    for (const value of [null, [], { errors: "invalid" }, { data: { issue: {} } }]) {
      data = value;
      await expect(linearRequest("fixture", "query Fixture").then(value => parseLinearResponse(issue, value))).rejects.toMatchObject({ status: 502 });
    }
    expect(calls).toBe(4);
    data = { data: { issue: null, added: true } };
    expect(parseLinearResponse(issue, await linearRequest("fixture", "query Fixture"))).toEqual({ issue: null });
    for (const [code, status] of [["RATELIMITED", 429], ["AUTHENTICATION_ERROR", 401], ["FORBIDDEN", 403]]) {
      data = { errors: [{ extensions: { code } }] };
      await expect(linearRequest("fixture", "query Fixture")).rejects.toMatchObject({ status });
    }
    const receipts = [];
    mock.module("@/lib/linear/connections", () => ({ linearAccess: async () => ({ token: "fixture", connectionId: "connection" }) }));
    mock.module("@/lib/linear/authority", () => ({ withLinearAuthority: async (_user, _access, _write, work) => work() }));
    mock.module("@/lib/linear/receipts", () => ({ reserveLinearReceipt: async () => ({ fresh: true }), finishLinearReceipt: async (_connection, _operation, result) => receipts.push(result) }));
    const { createLinearIssue } = await import("./lib/linear/operations.ts");
    calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json(calls === 1 ? { data: { team: { id: "team" } } } : { data: { issueCreate: { success: true, issue: { id: 42 } } } }); };
    await expect(createLinearIssue("user", { organizationId: "org", connectionId: "00000000-0000-4000-8000-000000000001", operationId: "00000000-0000-4000-8000-000000000002", teamId: "00000000-0000-4000-8000-000000000003", title: "Fixture" })).rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(2);
    expect(receipts).toEqual([undefined]);
  `,
    ],
    { cwd: resolve(import.meta.dir, "../.."), env: process.env },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
});
