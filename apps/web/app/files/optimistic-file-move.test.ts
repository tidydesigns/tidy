import { expect, test } from "bun:test";
import { projectFileMove, settleFileMove } from "./optimistic-file-move";
import { indexFolderFiles } from "./folder-file-index";

const source = { id: "file", folderId: "source", updatedAt: "2026-10-01T00:00:00Z" };
const move = { operationId: "move-1", folderId: "destination", updatedAt: source.updatedAt };

test("pending moves appear in the destination without waiting for refreshed data", () => {
  const index = indexFolderFiles([projectFileMove(source, move)], true);
  expect(index.get("source")).toBeUndefined();
  expect(index.get("destination")?.map((file) => file.id)).toEqual(["file"]);
  expect(projectFileMove(source, { ...move, folderId: null }).folderId).toBeNull();
  expect(source.folderId).toBe("source");
});

test("settled moves survive stale data but yield to subsequent server changes", () => {
  const completed = settleFileMove({ file: move }, "file", "move-1", true).file;
  expect(projectFileMove(source, completed).folderId).toBe("destination");
  const acknowledged = { ...source, folderId: "destination", updatedAt: "2026-10-02T00:00:00Z" };
  expect(projectFileMove(acknowledged, completed)).toBe(acknowledged);
  const movedElsewhere = { ...source, folderId: "elsewhere", updatedAt: "2026-10-03T00:00:00Z" };
  expect(projectFileMove(movedElsewhere, completed)).toBe(movedElsewhere);
});

test("failure rolls back only the failed move, using the latest source metadata", () => {
  const rolledBack = settleFileMove({ file: move }, "file", "move-1", false);
  const latest = { ...source, name: "Concurrent rename" };
  expect(projectFileMove(latest, rolledBack.file)).toBe(latest);
  const newer = { file: { ...move, operationId: "move-2", folderId: "elsewhere" } };
  expect(settleFileMove(newer, "file", "move-1", false)).toBe(newer);
  expect(settleFileMove(newer, "file", "move-1", true)).toBe(newer);
});
