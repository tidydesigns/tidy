import { expect, test } from "bun:test";
import { CloudReferenceCatalogs } from "./cloud-reference-catalogs";
import type { CloudCatalog } from "../../../../shared/contracts/cloud-sync";
const catalog: CloudCatalog = {
  files: [{ id: crypto.randomUUID(), name: "Design", folderId: null }],
  folders: [],
};
async function until(predicate: () => boolean) {
  for (let count = 0; !predicate(); count++) {
    if (count > 100) throw new Error("Catalog did not settle");
    await Bun.sleep(1);
  }
}

test("cached designs remain visible during refresh and after a network failure, and retry replaces them", async () => {
  const refresh = Promise.withResolvers<CloudCatalog>();
  let attempt = 0;
  const library = new CloudReferenceCatalogs(
    {
      catalog: async (_id, cached) =>
        cached ? catalog : ++attempt === 1 ? refresh.promise : { ...catalog, files: [] },
    },
    () => true,
  );
  library.load("org");
  await until(() => library.snapshot().org?.kind === "ready");
  expect(library.snapshot().org).toEqual({ kind: "ready", catalog });
  refresh.reject(new Error("Offline"));
  await until(() =>
    (() => {
      const value = library.snapshot().org;
      return value?.kind === "ready" && Boolean(value.error);
    })(),
  );
  library.load("org", true);
  await until(() =>
    (() => {
      const value = library.snapshot().org;
      return value?.kind === "ready" && !value.error;
    })(),
  );
  expect(library.snapshot().org).toEqual({ kind: "ready", catalog: { ...catalog, files: [] } });
});

test("catalog preloads are deduplicated and bounded to four concurrent workspaces", async () => {
  const release = Promise.withResolvers<void>();
  let active = 0,
    peak = 0,
    calls = 0;
  const library = new CloudReferenceCatalogs(
    {
      catalog: async (_id, cached) => {
        if (cached) throw new Error("No cache");
        calls++;
        active++;
        peak = Math.max(active, peak);
        await release.promise;
        active--;
        return catalog;
      },
    },
    () => true,
  );
  for (let index = 0; index < 12; index++) {
    library.load(`${index}`);
    library.load(`${index}`);
  }
  await until(() => active === 4);
  expect(peak).toBe(4);
  release.resolve();
  await until(
    () => Object.values(library.snapshot()).filter((value) => value.kind === "ready").length === 12,
  );
  expect(calls).toBe(12);
});

test("an account change drops stale catalog results and stops queued network work", async () => {
  const release = Promise.withResolvers<CloudCatalog>();
  let current = true,
    calls = 0;
  const library = new CloudReferenceCatalogs(
    {
      catalog: async (_id, cached) => {
        if (cached) throw new Error("No cache");
        calls++;
        return release.promise;
      },
    },
    () => current,
  );
  for (let index = 0; index < 8; index++) library.load(`${index}`);
  await until(() => calls === 4);
  current = false;
  release.resolve(catalog);
  await Bun.sleep(10);
  expect(calls).toBe(4);
  expect(Object.values(library.snapshot()).some((value) => value.kind === "ready")).toBe(false);
});
