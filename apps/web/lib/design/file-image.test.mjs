import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("file image reads use private R2 originals, preserve layer context and fall back to legacy bytes", () => {
  // Isolate Cloudflare mocks from other suites.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    let allowed = true, r2Available = true, legacyAvailable = true, gets = 0, bodyReads = 0;
    const assetId = "00000000-0000-4000-8000-000000000001";
    const bytes = Buffer.from("original screenshot pixels");
    const crop = { x: .1, y: .2, width: .5, height: .5, sourceWidth: 100, sourceHeight: 100 };
    const nodes = [
      { id: "image", name: "Screenshot", type: "image", assetId, style: { imageCrop: crop }, box: { x: 0, y: 0, width: 50, height: 50 } },
      { id: "fill", name: "Image fill", type: "container", style: { paints: [{ type: "image", assetId }] }, box: { x: 0, y: 0, width: 50, height: 50 } },
      { id: "master", name: "Variant reference", type: "container", style: {}, box: { x: 0, y: 0, width: 50, height: 50 },
        variants: { options: { secondary: { children: { child: { assetId } } } } } },
    ];
    const image = { revision: 9, content: { nodes }, mimeType: "image/png", objectKey: "private-original", sha256: null, byteSize: bytes.length };
    const query = async (sql, params) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
      expect(params).toEqual(sql.startsWith('select a."body"') ? ["file", assetId, "viewer", 12_000_000] : ["file", assetId, "viewer"]);
      if (sql.startsWith('select d.')) return { rows: allowed ? [image] : [] };
      if (sql.startsWith('select a."body"')) { bodyReads++; return { rows: legacyAvailable ? [{ body: bytes }] : [] }; }
      throw new Error("Unexpected SQL");
    };
    mock.module("@/lib/db", () => ({ db: { connect: async () => ({ query, release() {} }) } }));
    mock.module("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: { DESIGN_OBJECTS: { get: async key => {
      expect(key).toBe("private-original"); gets++;
      return r2Available ? { body: new Response(bytes).body, arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
    } } } }) }));
    const { getFileImage } = await import("./lib/design/file-image.ts");
    const read = () => getFileImage("viewer", "file", assetId);
    const response = await read();
    expect(response.base64).toBe(bytes.toString("base64"));
    expect(response.layers.map(layer => layer.nodeId)).toEqual(["image", "fill", "master"]);
    expect(response.layers[0].imageCrop).toEqual(crop);
    expect(response).not.toHaveProperty("objectKey");
    expect(bodyReads).toBe(0); expect(gets).toBe(1);
    allowed = false;
    await expect(read()).rejects.toThrow("not found or access denied"); expect(gets).toBe(1);
    allowed = true;
    image.content.nodes = [];
    await expect(read()).rejects.toThrow("not found or access denied"); expect(gets).toBe(1);
    image.content.nodes = nodes;
    r2Available = false;
    expect((await read()).base64).toBe(bytes.toString("base64")); expect(bodyReads).toBe(1);
    image.objectKey = null;
    expect((await read()).base64).toBe(bytes.toString("base64")); expect(gets).toBe(2); expect(bodyReads).toBe(2);
    legacyAvailable = false;
    await expect(read()).rejects.toThrow("bytes are unavailable");
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
