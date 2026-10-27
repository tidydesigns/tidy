import { expect, test } from "bun:test";
import { blankDesignDocument } from "@tidy/design/document";
import { DesignPreviewCache } from "./cache";
import type { LocalDesign } from "../../../../../shared/contracts/desktop";

const design = (id: string): LocalDesign => ({
  id,
  name: id,
  path: `/project/.tidy/designs/${id}.json`,
  updatedAt: "2026-10-23T12:00:00.000Z",
  version: "1",
  document: blankDesignDocument(),
  assets: {},
});

test("shared window and thumbnail requests deduplicate reads without republishing cache hits", async () => {
  let reads = 0;
  const cache = new DesignPreviewCache(async (id) => {
    reads++;
    return design(id);
  });
  const first = cache.load(design("a"));
  expect(cache.load(design("a"))).toBe(first);
  await first;
  const snapshot = cache.getSnapshot();
  await cache.load(design("a"));
  expect(reads).toBe(1);
  expect(cache.getSnapshot()).toBe(snapshot);
});

test("asset-heavy entries are evicted in least-recently-used order", async () => {
  let reads = 0;
  const cache = new DesignPreviewCache(async (id) => {
    reads++;
    return design(id);
  }, 2);
  for (const id of ["a", "b", "a", "c"]) await cache.load(design(id));
  expect(Object.keys(cache.getSnapshot())).toEqual(["a", "c"]);
  await cache.load(design("b"));
  expect(reads).toBe(4);
  expect(Object.keys(cache.getSnapshot())).toEqual(["c", "b"]);
});

test("preview reads bound concurrency and a failed request releases its queue slot", async () => {
  let active = 0,
    peak = 0;
  let fail = true;
  const cache = new DesignPreviewCache(async (id) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    if (id === "0" && fail) {
      fail = false;
      throw new Error("atomic write in progress");
    }
    return design(id);
  });
  const values = await Promise.allSettled(
    Array.from({ length: 12 }, (_, id) => cache.load(design(String(id)))),
  );
  expect(peak).toBe(2);
  expect(values.filter((value) => value.status === "fulfilled")).toHaveLength(11);
  expect(Object.keys(cache.getSnapshot())).toHaveLength(8);
  expect((await cache.load(design("0"))).id).toBe("0");
});

test("an old read cannot replace a newer edit even at the same timestamp after cache eviction", async () => {
  let finish!: (value: LocalDesign) => void;
  const cache = new DesignPreviewCache(
    (id) =>
      id === "a"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(design(id)),
    2,
  );
  const old = cache.load(design("a"));
  await Promise.resolve();
  const edited = { ...design("a"), version: "2", name: "Latest edit" };
  cache.update(edited);
  await cache.load(design("b"));
  await cache.load(design("c"));
  expect(cache.getSnapshot().a).toBeUndefined();
  finish(design("a"));
  expect(await old).toBe(edited);
  expect(cache.getSnapshot().a.version).toBe("2");
});
