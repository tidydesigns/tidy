import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "@tidy/design/document";
import { diffDocument } from "@tidy/design/document-patch";
import { MobileCloud } from "./cloud";

test("cloud reads request revision deltas and reject missing revisions", async () => {
  const content = {
    ...blankDesignDocument(),
    nodes: [
      buildDrawnNode(crypto.randomUUID(), "text", null, { x: 0, y: 0, width: 200, height: 32 }),
    ],
  };
  const next = { ...content, nodes: content.nodes.map((node) => ({ ...node, text: "From web" })) };
  const base = { revision: 4, content, name: "Shared file", canEdit: true };
  const fileId = crypto.randomUUID();
  let gap = false;
  const cloud = new MobileCloud(async (path) => {
    expect(path).toBe(`/api/desktop/files/${fileId}?revision=4`);
    return Response.json({
      name: base.name,
      canEdit: true,
      sequence: 5,
      baseRevision: 4,
      revision: gap ? 6 : 5,
      patches: [{ baseRevision: 4, revision: 5, patch: diffDocument(content, next) }],
    });
  });
  expect((await cloud.read(fileId, base)).content.nodes[0].text).toBe("From web");
  gap = true;
  await expect(cloud.read(fileId, base)).rejects.toThrow("incomplete");
});

test("commits send the durable receipt and enforce the server's revision acknowledgement", async () => {
  const content = blankDesignDocument(),
    next = { ...content, tokens: { accent: "#123456" } };
  const upload = {
    operationId: crypto.randomUUID(),
    base: { revision: 2, content, name: "File", canEdit: true },
    patch: diffDocument(content, next),
  };
  const fileId = crypto.randomUUID();
  let wrong = false;
  const cloud = new MobileCloud(async (path, init) => {
    expect(path).toBe(`/api/desktop/files/${fileId}`);
    expect(JSON.parse(init!.body as string)).toEqual({
      operationId: upload.operationId,
      baseRevision: 2,
      patch: upload.patch,
    });
    return Response.json({ baseRevision: 2, revision: wrong ? 4 : 3, patch: upload.patch });
  });
  expect((await cloud.commit(fileId, upload)).content.tokens.accent).toBe("#123456");
  wrong = true;
  await expect(cloud.commit(fileId, upload)).rejects.toThrow("revision");
});
