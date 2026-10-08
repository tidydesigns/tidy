import { expect, test } from "bun:test";
import { blankDesignDocument, designNodeSchema, parseDesignDocument } from "./document";
import { mergeImport } from "./merge-import";
import { diagnoseLayout } from "./layout-diagnostics";
import { syncComponentEdit } from "./component-sync";

function fixture(prefix = "") {
  const node = (id: string, changes: object) =>
    designNodeSchema.parse({
      id: `${prefix}${id}`,
      parentId: null,
      name: id,
      type: "container",
      box: { x: 0, y: 0, width: 200, height: 100 },
      sourceKey: id,
      importKey: "project:/components",
      ...changes,
    });
  return parseDesignDocument({
    ...blankDesignDocument(),
    source: { project: "project", route: "/components" },
    nodes: [
      node("master", { isComponent: true }),
      node("label", { parentId: `${prefix}master`, type: "text", text: "Create" }),
      node("instance", { instanceOf: `${prefix}master`, componentSourceId: `${prefix}master` }),
      node("copy-label", {
        parentId: `${prefix}instance`,
        type: "text",
        text: "Create",
        instanceOf: `${prefix}master`,
        componentSourceId: `${prefix}label`,
      }),
    ],
  });
}
test("reimports remap component and child source IDs to stable IDs", () => {
  const result = mergeImport(fixture(), fixture("new-"), "rerun", "use_import");
  expect(result.nodes.find((node) => node.id === "instance")).toMatchObject({
    instanceOf: "master",
    componentSourceId: "master",
  });
  expect(diagnoseLayout(result).filter((issue) => issue.severity === "error")).toEqual([]);
  const changed = syncComponentEdit(result.nodes, "label", { text: "Updated" });
  expect(changed.find((node) => node.id === "copy-label")?.text).toBe("Updated");
});
test("duplicate imports keep their instance edits linked to their own masters", () => {
  const result = mergeImport(fixture(), fixture(), "duplicate", "duplicate");
  const changed = syncComponentEdit(result.nodes, "duplicate-label", { text: "Duplicate updated" });
  expect(changed.find((node) => node.id === "duplicate-copy-label")?.text).toBe(
    "Duplicate updated",
  );
  expect(changed.find((node) => node.id === "copy-label")?.text).toBe("Create");
  expect(changed.find((node) => node.id === "label")?.text).toBe("Create");
});
