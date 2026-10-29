import { expect, test } from "bun:test";
import { newestThumbnailVersion, reconcileThumbnailVersions } from "./thumbnail-versions";

const old = "1:2026-10-01T00:00:00.000Z";
const fresh = "2:2026-10-02T00:00:00.000Z";
const initial = {
  versions: { allowed: old, revoked: old, otherBatch: old },
  thumbnailVersions: { allowed: `png-v2:${old}`, revoked: `png-v2:${old}`, otherBatch: null },
};

test("an authoritative omission revokes only requested previews and allows later recovery", () => {
  const result = {
    versions: { allowed: fresh },
    thumbnailVersions: { allowed: `png-v2:${fresh}` },
  };
  const next = reconcileThumbnailVersions(initial, ["allowed", "revoked"], result);
  expect(next.versions).toEqual({ allowed: fresh, revoked: null, otherBatch: old });
  expect(next.thumbnailVersions.revoked).toBeNull();
  expect(initial.versions.revoked).toBe(old);
  expect(reconcileThumbnailVersions(next, ["allowed", "revoked"], result)).toBe(next);
  expect(
    reconcileThumbnailVersions(next, ["revoked"], { versions: { revoked: old } }).versions.revoked,
  ).toBe(old);
});

test("authentication denial clears all checked previews without accepting unrequested records", () => {
  const denied = reconcileThumbnailVersions(initial, Object.keys(initial.versions), {
    versions: {},
  });
  expect(Object.values(denied.versions)).toEqual([null, null, null]);
  expect(Object.values(denied.thumbnailVersions)).toEqual([null, null, null]);
  expect(
    reconcileThumbnailVersions(denied, ["allowed"], { versions: { injected: fresh } }).versions,
  ).not.toHaveProperty("injected");
});

test("stale polling cannot force regeneration when server props supply a newer saved thumbnail", () => {
  expect(newestThumbnailVersion(`png-v2:${fresh}`, `png-v2:${old}`)).toBe(`png-v2:${fresh}`);
  expect(newestThumbnailVersion(`png-v2:${old}`, `png-v2:${fresh}`)).toBe(`png-v2:${fresh}`);
  expect(newestThumbnailVersion(null, `png-v2:${fresh}`)).toBe(`png-v2:${fresh}`);
  expect(newestThumbnailVersion(`png-v2:${fresh}`, null)).toBe(`png-v2:${fresh}`);
  expect(newestThumbnailVersion(`png-v2:${fresh}`, `png-v1:${fresh}`)).toBe(`png-v2:${fresh}`);
});
