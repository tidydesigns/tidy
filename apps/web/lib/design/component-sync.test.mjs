import { test, expect } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "./document";
import { createComponentInstance, makeComponent } from "./document-operations";
import { syncComponentEdit } from "./component-sync";

test("master edits update instances while local overrides stay in place", () => {
  const master = buildDrawnNode("master", "container", null, {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
  });
  const label = {
    ...buildDrawnNode("label", "text", "master", { x: 5, y: 5, width: 80, height: 20 }),
    text: "Original",
  };
  const document = makeComponent({ ...blankDesignDocument(), nodes: [master, label] }, "master");
  let index = 0;
  const instance = createComponentInstance(document, "master", () => `copy-${++index}`);
  const copiedLabel = instance.document.nodes.find((node) => node.componentSourceId === "label");
  expect(copiedLabel?.text).toBe("Original");
  const changed = syncComponentEdit(instance.document.nodes, "label", { text: "Updated" });
  expect(changed.find((node) => node.id === copiedLabel.id)?.text).toBe("Updated");
  const overridden = syncComponentEdit(changed, copiedLabel.id, { text: "Custom" });
  const afterMasterEdit = syncComponentEdit(overridden, "label", { text: "Newest" });
  expect(afterMasterEdit.find((node) => node.id === copiedLabel.id)?.text).toBe("Custom");
  expect(afterMasterEdit.find((node) => node.id === "label")?.text).toBe("Newest");
  expect(afterMasterEdit.find((node) => node.id === instance.rootId)?.box.x).toBe(34);
});
