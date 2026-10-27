import { afterEach, expect, spyOn, test } from "bun:test";
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

test("private cloud images require account authorization and recheck after disk reads", async () => {
  const f = await fixture();
  await f.store.open(join(f.root, "project"), "Team");
  expect((await projectAssetResponse(f.store, new Request(f.url))).status).toBe(404);
  let calls = 0;
  const allowed = await projectAssetResponse(f.store, new Request(f.url), undefined, async () => {
    calls++;
  });
  expect(allowed.status).toBe(200);
  expect(calls).toBe(2);
  calls = 0;
  const denied = await projectAssetResponse(f.store, new Request(f.url), undefined, async () => {
    if (++calls > 1) throw new Error("Account changed");
  });
  expect(denied.status).toBe(404);
  expect(await denied.text()).toBe("");
});

test("missing images load through the authorized asset protocol and retry URLs retain validation", async () => {
  const f = await fixture();
  const assetId = randomUUID();
  const url = `http://localhost/__tidy/assets/${f.project.id}/${assetId}?retry=1`;
  const dataUrl = "data:image/png;base64,cHJvZ3Jlc3NpdmU=";
  const reads = spyOn(f.store, "readSyncAsset");
  let allowed = true;
  let loads = 0;
  const authorize = async () => {
    if (!allowed) throw new Error("Account changed");
  };
  const load = async (projectId: string, id: string) => {
    loads++;
    expect(projectId).toBe(f.project.id);
    expect(id).toBe(assetId);
    await f.store.cacheSyncAsset(projectId, id, dataUrl);
    return dataUrl;
  };
  try {
    const response = await projectAssetResponse(
      f.store,
      new Request(url),
      undefined,
      authorize,
      load,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("progressive");
    expect(loads).toBe(1);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(
      (await projectAssetResponse(f.store, new Request(url), undefined, authorize, load)).status,
    ).toBe(200);
    expect(loads).toBe(1);
    await rm(await f.store.storagePath(f.project.id, "assets", assetId));
    const denied = await projectAssetResponse(
      f.store,
      new Request(url),
      undefined,
      authorize,
      async (projectId, id) => {
        const image = await load(projectId, id);
        allowed = false;
        return image;
      },
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe("");
  } finally {
    reads.mockRestore();
  }
});

test("loaded image bytes retain MIME and size limits", async () => {
  const f = await fixture();
  for (const image of [
    "data:text/html;base64,cHJpdmF0ZQ==",
    `data:image/png;base64,${"A".repeat(3_000_000)}`,
  ]) {
    const response = await projectAssetResponse(
      f.store,
      new Request(`http://localhost/__tidy/assets/${f.project.id}/${randomUUID()}`),
      undefined,
      async () => {},
      async () => image,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  }
});
