import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "./project-store";
import { projectAssetResponse } from "./project-assets";

const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-project-images-"));
  cleanups.push(root);
  await mkdir(join(root, "project"));
  const store = new ProjectStore(join(root, "registry"));
  await store.initialize();
  const { project } = await store.open(join(root, "project"));
  const data = Buffer.from("synthetic image bytes");
  const image = await store.uploadDesignAsset(
    project.id,
    `data:image/png;base64,${data.toString("base64")}`,
  );
  return { root, store, project, data, image, url: `http://localhost${image.url}` };
}

test("local asset URLs serve original bytes separately and revalidate cached images", async () => {
  const f = await fixture();
  expect(f.image.url).toBe(`/__tidy/assets/${f.project.id}/${f.image.assetId}`);
  const response = await projectAssetResponse(f.store, new Request(f.url));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(f.data);
  const cached = await projectAssetResponse(
    f.store,
    new Request(f.url, {
      headers: { "If-None-Match": response.headers.get("etag")! },
    }),
  );
  expect(cached.status).toBe(304);
  const head = await projectAssetResponse(f.store, new Request(f.url, { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});

test("asset requests reject unknown projects, traversal, unsafe MIME types and symbolic links", async () => {
  const f = await fixture();
  for (const url of [
    `http://localhost/__tidy/assets/${randomUUID()}/${f.image.assetId}`,
    `http://localhost/__tidy/assets/${f.project.id}/${randomUUID()}`,
    `${f.url}?path=/etc/passwd`,
    `http://localhost/__tidy/assets/${f.project.id}/%2e%2e%2fprivate.json`,
    `http://localhost/__tidy/assets/${f.project.id}/not-a-uuid`,
  ])
    expect((await projectAssetResponse(f.store, new Request(url))).status).toBe(404);
  expect((await projectAssetResponse(f.store, new Request(f.url, { method: "POST" }))).status).toBe(
    404,
  );
  const path = await f.store.storagePath(f.project.id, "assets", f.image.assetId);
  await writeFile(path, JSON.stringify({ dataUrl: "data:text/html;base64,PHNjcmlwdD4=" }));
  expect((await projectAssetResponse(f.store, new Request(f.url))).status).toBe(404);
  await rm(path);
  const outside = join(f.root, "outside.json");
  await writeFile(outside, JSON.stringify({ dataUrl: "data:image/png;base64,cHJpdmF0ZQ==" }));
  await symlink(outside, path);
  expect((await projectAssetResponse(f.store, new Request(f.url))).status).toBe(404);
});
