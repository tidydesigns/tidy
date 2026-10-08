import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { imageDigest, verifiedObject } from "./object-migration";

test("backfill rejects corrupt objects before publishing or pruning a pointer", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const expected = { sha256: imageDigest(bytes), byteSize: bytes.length };
  expect(await verifiedObject("original", expected, async () => bytes.buffer)).toEqual(bytes);
  await expect(
    verifiedObject("original", expected, async () => new Uint8Array([1, 2, 4]).buffer),
  ).rejects.toThrow("verification");
  await expect(
    verifiedObject("original", expected, async () => new Uint8Array([1, 2]).buffer),
  ).rejects.toThrow("verification");
});

test("R2 bytes, variants and internal cache are gated by current membership; legacy assets still load", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    mock.module("server-only", () => ({}));
    import { createHash } from "node:crypto";
    let session = { user: { id: "owner" } }, member = true, gets = 0, transforms = 0, bodyReads = 0, puts = 0, failPut = false;
    const bytes = new Uint8Array([137,80,78,71,13,10,26,10]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const objects = new Map(), cached = new Map(), waits = [];
    const object = key => objects.has(key) ? { body: new Response(objects.get(key).bytes).body, size: bytes.length,
      customMetadata: { sha256: digest }, arrayBuffer: async () => objects.get(key).bytes.buffer } : null;
    const bucket = {
      put: async (key, body, options) => { puts++; if (failPut) throw new Error("R2 unavailable"); if (objects.has(key)) return null; objects.set(key, { bytes: new Uint8Array(body), options }); return object(key); },
      get: async key => { gets++; return object(key); }, head: async key => object(key),
    };
    const metadata = { mimeType: "image/png", objectKey: "original", sha256: digest, byteSize: bytes.length, organizationId: "org" };
    objects.set("original", { bytes });
    const assetRows = new Map();
    const query = async (sql, values = []) => {
      if (sql.includes("as ready")) return { rows: [{ ready: true }], rowCount: 1 };
      if (sql.startsWith('select 1 from "member"')) return { rows: member ? [{}] : [], rowCount: member ? 1 : 0 };
      if (sql.startsWith('select "id" from "designAsset"')) return { rows: assetRows.has(values[1]) ? [assetRows.get(values[1])] : [] };
      if (sql.startsWith('insert into "designAsset"')) { expect(values[4]).toBeNull(); expect(values[5]).toContain(digest); assetRows.set(digest, { id: values[0] }); return { rows: [{ id: values[0] }] }; }
      if (sql.startsWith('select a."mimeType"')) return { rows: member ? [metadata] : [] };
      if (sql.startsWith('select a."body"')) { bodyReads++; return { rows: member ? [{ body: Buffer.from(bytes) }] : [] }; }
      return { rows: [], rowCount: 1 };
    };
    mock.module("@/lib/db", () => ({ db: { query, connect: async () => ({ query, release() {} }) } }));
    mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => session } } }));
    mock.module("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: { DESIGN_OBJECTS: bucket,
      IMAGES: { input: stream => ({ transform: options => { expect(options).toEqual({ width: 256, fit: "scale-down" }); transforms++; return { output: async () => ({ response: () => new Response("small-image") }) }; } }) } },
      ctx: { waitUntil: promise => waits.push(promise) } }) }));
    globalThis.caches = { default: { match: async request => cached.get(request.url)?.clone(), put: async (request,response) => cached.set(request.url,response) } };
    const { GET } = await import("./app/api/assets/[id]/route.ts");
    const context = { params: Promise.resolve({ id: "asset" }) };
    const request = new Request("https://app.example/api/assets/asset");
    session = null; expect((await GET(request, context)).status).toBe(401);
    session = { user: { id: "owner" } };
    const original = await GET(request, context);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
    expect(original.headers.get("cache-control")).toBe("private, no-cache");
    expect(bodyReads).toBe(0); await Promise.all(waits);
    const reads = gets;
    expect(new Uint8Array(await (await GET(request, context)).arrayBuffer())).toEqual(bytes);
    expect(gets).toBe(reads);
    member = false; expect((await GET(request, context)).status).toBe(404); expect(gets).toBe(reads);
    member = true;
    const notModified = await GET(new Request(request.url, { headers: { "If-None-Match": original.headers.get("etag") } }), context);
    expect(notModified.status).toBe(304); expect(gets).toBe(reads);
    const smallRequest = new Request(request.url + "?width=256");
    expect(await (await GET(smallRequest,context)).text()).toBe("small-image");
    await Promise.all(waits);
    expect(await (await GET(smallRequest,context)).text()).toBe("small-image"); expect(transforms).toBe(1);
    metadata.objectKey = null;
    expect(new Uint8Array(await (await GET(request, context)).arrayBuffer())).toEqual(bytes); expect(bodyReads).toBe(1);
    const { putAsset } = await import("./lib/design/document-service.ts");
    member = false; await expect(putAsset("outsider","org","image/png",Buffer.from(bytes).toString("base64"))).rejects.toThrow("access denied"); expect(puts).toBe(0);
    member = true; failPut = true;
    await expect(putAsset("owner","org","image/png",Buffer.from(bytes).toString("base64"))).rejects.toThrow("R2 unavailable"); expect(assetRows.size).toBe(0);
    failPut = false;
    const uploaded = await putAsset("owner","org","image/png",Buffer.from(bytes).toString("base64"));
    expect(await putAsset("owner","org","image/png",Buffer.from(bytes).toString("base64"))).toEqual(uploaded);
    const { storeDesignObject, designObjectKey } = await import("./lib/storage/design-objects.ts");
    await storeDesignObject("org", "image/png", bytes);
    expect(designObjectKey("org",digest,"image/png")).not.toBe(designObjectKey("other",digest,"image/png"));
    console.log("PASS");
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  expect(new TextDecoder().decode(child.stdout)).toContain("PASS");
});

test("bounded original reads reject understated bytes and stop on caller cancellation", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    let gets=0, canceled=0, stalled=false, fallbackReads=0;
    mock.module("@/lib/db", () => ({ db: { query: async () => ({rows:[]}) } }));
    mock.module("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: { DESIGN_OBJECTS: {
      get: async () => {
        gets++;
        if (stalled) return await new Promise(() => {});
        return {size:1,body:new ReadableStream({
          start(controller) {controller.enqueue(new Uint8Array([1,2,3,4]));},
          cancel() {canceled++; return new Promise(() => {});}
        })};
      }
    } } }) }));
    const {designObjectBytes}=await import("./lib/storage/design-objects.ts");
    const metadata={mimeType:"image/png",objectKey:"private",sha256:null,byteSize:1};
    const fallback=async()=>{fallbackReads++;return Buffer.from([1]);};
    await expect(designObjectBytes(metadata,fallback,3)).rejects.toThrow("too large");
    expect(canceled).toBe(1); expect(fallbackReads).toBe(0);
    const aborted=new AbortController();aborted.abort(new Error("caller canceled"));
    await expect(designObjectBytes(metadata,fallback,3,aborted.signal)).rejects.toThrow("caller canceled");
    expect(gets).toBe(1);
    stalled=true;
    const active=new AbortController();
    const read=designObjectBytes(metadata,fallback,3,active.signal);
    active.abort(new Error("headers canceled"));
    await expect(read).rejects.toThrow("headers canceled");
    expect(fallbackReads).toBe(0);
    await expect(designObjectBytes({...metadata,objectKey:null},async()=>Buffer.alloc(4),3)).rejects.toThrow("read allowance");
    console.log("PASS");
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  expect(new TextDecoder().decode(child.stdout)).toContain("PASS");
});

test("private display reads bound originals and transformed output and cancel stalled transforms/cache reads", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import {mock,expect} from "bun:test";
    mock.module("@/lib/db",()=>({db:{}}));
    let mode="original",gets=0,transforms=0,cachePuts=0,enter;
    let entered=new Promise(resolve=>{enter=resolve});
    mock.module("@opennextjs/cloudflare",()=>({getCloudflareContext:()=>({env:{
      DESIGN_OBJECTS:{get:async()=>{gets++; return {size:1,body:new Response(mode==="original"?new Uint8Array(3_000_001):new Uint8Array([1])).body};}},
      IMAGES:{input:()=>({transform:()=>({output:async()=>{transforms++; if(mode==="transform-stall"){enter();return new Promise(()=>{});} return {response:()=>new Response(new Uint8Array(3_000_001))};}})})}
    },ctx:{waitUntil:promise=>promise.catch(()=>{})}})}));
    globalThis.caches={default:{match:async()=>{if(mode==="cache-stall"){enter();return new Promise(()=>{});} return null;},put:async()=>{cachePuts++;}}};
    const {designImageResponse}=await import("./lib/storage/design-objects.ts");
    const metadata={mimeType:"image/png",objectKey:"private",sha256:null,byteSize:1};
    const request=signal=>new Request("https://app.example/image?width=256",{signal});
    await expect(designImageResponse(metadata,async()=>null,request())).rejects.toThrow("too large");
    expect(transforms).toBe(0); expect(cachePuts).toBe(0);
    mode="output";
    await expect(designImageResponse(metadata,async()=>null,request())).rejects.toThrow("too large");
    expect(transforms).toBe(1); expect(cachePuts).toBe(0);
    for(const next of ["transform-stall","cache-stall"]){
      mode=next; entered=new Promise(resolve=>{enter=resolve});
      const controller=new AbortController(), before=gets;
      const reading=designImageResponse(metadata,async()=>null,request(controller.signal));
      await entered; controller.abort(); await expect(reading).rejects.toThrow();
      if(next==="cache-stall")expect(gets).toBe(before);
    }
    expect(cachePuts).toBe(0); console.log("PASS");
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString()).toContain("PASS");
});
