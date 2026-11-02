import { expect, test } from "bun:test";
import {
  changedFileDirectories,
  changeFolderExceptionLimit,
  changeFolderSchema,
  expandedChangeFolders,
  toggleChangeFolder,
  type ChangeFolderState,
} from "./repository-navigation";
import { visibleTreeRows } from "./file-rows";

test("changed file navigation includes nested and deleted files without unrelated files", () => {
  const model = changedFileDirectories([
    { path: "src/ui/button.ts", previousPath: null, status: "modified" },
    { path: "src/app.ts", previousPath: null, status: "added" },
    { path: "README.md", previousPath: null, status: "deleted" },
  ]);
  const rows = visibleTreeRows(model, new Set(model.keys()));
  expect(rows.map((row) => [row.path, row.depth])).toEqual([
    ["src", 1],
    ["src/ui", 2],
    ["src/ui/button.ts", 3],
    ["src/app.ts", 2],
    ["README.md", 1],
  ]);
  expect(visibleTreeRows(model, new Set()).map((row) => row.path)).toEqual(["src", "README.md"]);
});

test("file to folder replacements retain both changes without duplicate navigation paths", () => {
  const model = changedFileDirectories([
    { path: "src", previousPath: null, status: "deleted" },
    { path: "src/app.ts", previousPath: null, status: "added" },
  ]);
  expect(visibleTreeRows(model, new Set()).map((row) => row.path)).toEqual(["src", "src/app.ts"]);
});

test("collapse all hides every child across more than 64 changed folders", () => {
  const model = changedFileDirectories(
    Array.from({ length: 70 }, (_, index) => ({
      path: `package-${index}/index.ts`,
      previousPath: null,
      status: "modified" as const,
    })),
  );
  const state = { collapsed: true, exceptions: [] };
  expect(visibleTreeRows(model, expandedChangeFolders(model.keys(), state))).toHaveLength(70);
  const opened = toggleChangeFolder(state, "package-69");
  expect(visibleTreeRows(model, expandedChangeFolders(model.keys(), opened))).toHaveLength(71);
  expect(expandedChangeFolders(model.keys(), toggleChangeFolder(opened, "package-69")).size).toBe(
    0,
  );
  model.set("new-folder", { entries: [], limited: false });
  expect(expandedChangeFolders(model.keys(), state).size).toBe(0);
});

test("individual folder toggles never evict earlier collapsed folders", () => {
  const paths = Array.from({ length: 70 }, (_, index) => `package-${index}`);
  let state: ChangeFolderState = { collapsed: false, exceptions: [] };
  for (const path of paths) state = toggleChangeFolder(state, path);
  expect(expandedChangeFolders(paths, state).size).toBe(0);
  state = toggleChangeFolder(state, paths[69]);
  expect([...expandedChangeFolders(paths, state)]).toEqual([paths[69]]);
});

test("persisted collapsed-folder arrays migrate and bounded exceptions retain existing choices", () => {
  const legacy = changeFolderSchema.parse(["src", "tests"]);
  expect([...expandedChangeFolders(["src", "tests", "docs"], legacy)]).toEqual(["docs"]);
  const state = {
    collapsed: true,
    exceptions: Array.from(
      { length: changeFolderExceptionLimit },
      (_, index) => `package-${index}`,
    ),
  };
  expect(toggleChangeFolder(state, "extra")).toBe(state);
  expect(toggleChangeFolder(state, "package-0").exceptions).toHaveLength(
    changeFolderExceptionLimit - 1,
  );
});
