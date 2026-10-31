import { expect, test } from "bun:test";
import type { AttachedFile } from "../../../../shared/contracts/attachments";
import { restoreDraftAttachments } from "./draft-attachments";
import { copyDraft } from "./machine-context";

const file: AttachedFile = {
  id: crypto.randomUUID(),
  name: "layout.png",
  mimeType: "image/png",
  size: 10,
  importState: "pending",
};

test("history restoration marks cancelled imports as failed instead of leaving permanent loaders", () => {
  const restored = restoreDraftAttachments({ attachments: [file], isPending: () => false });
  expect(restored[0]).toEqual({ ...file, importState: "failed" });
});

test("history restoration keeps active imports and completed attachment aliases", () => {
  const ready: AttachedFile = {
    ...file,
    id: crypto.randomUUID(),
    referenceId: file.id,
    importState: undefined,
  };
  const restored = restoreDraftAttachments({
    attachments: [file, ready],
    isPending: (id) => id === file.id,
  });
  expect(restored[0]).toBe(file);
  expect(restored[1]).toBe(ready);
});

for (const importState of ["pending", "failed"] as const) {
  test(`moving a draft with ${importState} attachments rejects before export or import`, async () => {
    let exports = 0;
    let imports = 0;
    await expect(
      copyDraft({
        api: {
          exportAttachment: async () => {
            exports++;
            throw new Error("Unexpected export");
          },
        },
        source: {
          project: {
            id: crypto.randomUUID(),
            name: "Source",
            path: "/fixture/source",
            openedAt: new Date().toISOString(),
          },
          contextProjectId: crypto.randomUUID(),
          draft: {
            text: "Image",
            harness: "codex",
            designIds: [],
            attachments: [{ ...file, importState }],
          },
        },
        target: {
          importDraft: async () => {
            imports++;
            throw new Error("Unexpected import");
          },
        },
        projectId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Wait for attachments to load, or remove failed attachments");
    expect(exports).toBe(0);
    expect(imports).toBe(0);
  });
}
