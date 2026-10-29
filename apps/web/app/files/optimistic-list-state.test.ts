import { expect, test } from "bun:test";
import { retireAddedItems, retireNames, rollbackName } from "./optimistic-list-state";

test("acknowledged additions cannot reappear after a later deletion or archive", () => {
  const added = [{ id: "created" }, { id: "pending-other" }];
  const acknowledged = retireAddedItems(added, [{ id: "created" }]);
  expect(acknowledged).toEqual([{ id: "pending-other" }]);
  expect(retireAddedItems(acknowledged, [])).toBe(acknowledged);
  // Also covers server acknowledgement arriving before the temporary ID is replaced.
  expect(retireAddedItems([{ id: "created" }], [{ id: "created" }])).toEqual([]);
  expect(added).toHaveLength(2);
});

test("acknowledged renames yield to subsequent server names", () => {
  const names = { file: { name: "Renamed", operationId: "first" } };
  expect(retireNames(names, [{ id: "file", name: "Old" }])).toBe(names);
  const acknowledged = retireNames(names, [{ id: "file", name: "Renamed" }]);
  expect(acknowledged).toEqual({});
  expect(retireNames(acknowledged, [{ id: "file", name: "Someone else's rename" }])).toBe(
    acknowledged,
  );
  expect(names.file.name).toBe("Renamed");
});

test("late rename failure cannot overwrite a newer operation or acknowledged metadata", () => {
  const names = { file: { name: "Newer", operationId: "second" } };
  expect(rollbackName(names, "file", "first")).toBe(names);
  expect(rollbackName(names, "file", "second")).toEqual({});
  const acknowledged = {};
  expect(rollbackName(acknowledged, "file", "first")).toBe(acknowledged);
});
