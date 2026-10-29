import { expect, test } from "bun:test";
import { indexFolderFiles } from "./folder-file-index";

test("folder indexes preserve source order and isolate sorted folder contents", () => {
  const files = [
    { id: "older", folderId: "a", updatedAt: "2026-01-01" },
    { id: "root", folderId: null, updatedAt: "2026-03-01" },
    { id: "other", folderId: "b", updatedAt: "2026-02-01" },
    { id: "newer", folderId: "a", updatedAt: "2026-04-01" },
  ];
  const original = [...files];
  const newest = indexFolderFiles(files, true);
  expect(newest.get("a")?.map((file) => file.id)).toEqual(["newer", "older"]);
  expect(newest.get(null)?.map((file) => file.id)).toEqual(["root"]);
  expect(newest.get("b")?.map((file) => file.id)).toEqual(["other"]);
  expect(newest.get("missing")).toBeUndefined();
  expect(
    indexFolderFiles(files, false)
      .get("a")
      ?.map((file) => file.id),
  ).toEqual(["older", "newer"]);
  expect(files).toEqual(original);
});
