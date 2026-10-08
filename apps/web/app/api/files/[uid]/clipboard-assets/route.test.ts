import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("clipboard asset route checks origin/session, bounds streamed bodies and returns private mappings", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    let session = null, calls = [], mode="normal",admissions=0;
    const {MutationBudgetError}=await import("./lib/security/mutation-budget.ts");
    mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => session } } }));
    class ClipboardTransferError extends Error {};
    class ClipboardAccessError extends Error {};
    class ClipboardBudgetUnavailableError extends Error {};
    mock.module("@/lib/design/clipboard-assets", () => ({ ClipboardTransferError,
      ClipboardAccessError,ClipboardBudgetUnavailableError,
      transferClipboardAssets: async (actor,target,load) => {
        admissions++;
        if(mode==="budget")throw new MutationBudgetError(17);
        if(mode==="unavailable")throw new ClipboardBudgetUnavailableError("temporarily unavailable");
        if(mode==="sql")throw Object.assign(new Error("internal database secret"),{code:"XX000"});
        const input=await load();calls.push([actor,target,input]);return {source:"destination"};
      }
    }));
    const { POST } = await import("./app/api/files/[uid]/clipboard-assets/route.ts");
    const request = (body, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/files/target/clipboard-assets", {
      method: "POST", headers: { origin, "Content-Type": "application/json" }, body,
    });
    const context = { params: Promise.resolve({ uid: "target" }) };
    const forbidden = await POST(request("{}", "https://other.example"), context);
    const anonymous = await POST(request("{}"), context);
    session = { user: { id: "member" } };
    const invalid = await POST(request("{"), context);
    const oversized = await POST(request("x".repeat(256001)), context);
    const encoded=new Request("http://localhost:3000/api/files/target/clipboard-assets",{method:"POST",headers:{origin:"http://localhost:3000","Content-Type":"application/json","Content-Encoding":"gzip"},body:"{}"});
    const unsupported=await POST(encoded,context);
    const controller=new AbortController();controller.abort();
    const canceled=await POST(new Request("http://localhost:3000/api/files/target/clipboard-assets",{method:"POST",headers:{origin:"http://localhost:3000"},body:new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));}}),duplex:"half",signal:controller.signal}),context);
    const input = { sourceFile: "source", assetIds: [] };
    const result = await POST(request(JSON.stringify(input)), context);
    mode="budget";const limited=await POST(request("{}"),context);
    mode="unavailable";const unavailable=await POST(request("{}"),context);
    mode="sql";const database=await POST(request("{}"),context);
    console.log(JSON.stringify({ failureCodes:[unsupported.status,canceled.status,limited.status,unavailable.status,database.status],retry:limited.headers.get("Retry-After"),database:await database.json(),admissions,codes: [forbidden.status, anonymous.status, invalid.status, oversized.status, result.status],
      cache: result.headers.get("Cache-Control"), body: await result.json(), calls }));
  `,
    ],
    { cwd: resolve(import.meta.dir, "../../../../.."), stdout: "pipe", stderr: "pipe" },
  );
  expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  const result = JSON.parse(child.stdout.toString());
  expect(result.codes).toEqual([403, 401, 400, 413, 200]);
  expect(result.calls).toEqual([["member", "target", { sourceFile: "source", assetIds: [] }]]);
  expect(result.cache).toBe("private, no-store");
  expect(result.body).toEqual({ assets: { source: "destination" } });
  expect(result.failureCodes).toEqual([415, 408, 429, 503, 503]);
  expect(result.retry).toBe("17");
  expect(result.database).toEqual({ error: "Could not copy clipboard images." });
  expect(result.admissions).toBe(8);
});
