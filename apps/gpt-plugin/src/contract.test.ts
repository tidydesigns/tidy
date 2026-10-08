import { expect, test } from "bun:test";
import { fixture } from "../dev/fixture";
import { acceptPreview, readPreview } from "./contract";

test("reads private UI hydration and rejects unsafe assets or navigation", () => {
  const result = (value: unknown) => ({ _meta: { tidyPreview: value } });
  expect(readPreview(result(fixture))?.fileId).toBe(fixture.fileId);
  expect(readPreview({ structuredContent: fixture })).toBeNull();
  expect(readPreview(result({ ...fixture, url: "javascript:alert(1)" }))).toBeNull();
  expect(readPreview(result({ ...fixture, url: "https://app.tidydesign.co/settings" }))).toBeNull();
  expect(
    readPreview(result({ ...fixture, assets: { image: "https://untrusted.example/image.png" } })),
  ).toBeNull();
  expect(readPreview({ ...result(fixture), isError: true })).toBeNull();
});
test("a late response cannot undo a newer revision or switch back to an old file", () => {
  const newer = { ...fixture, revision: 4 };
  expect(acceptPreview(newer, fixture)).toBe(newer);
  const other = { ...fixture, fileId: "other" };
  expect(acceptPreview(other, newer, fixture.fileId)).toBe(other);
  expect(acceptPreview(fixture, newer, fixture.fileId)).toBe(newer);
});
