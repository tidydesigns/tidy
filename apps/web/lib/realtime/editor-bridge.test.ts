import { expect, test } from "bun:test";
import { EditorBridge, ownEditorSessions } from "./editor-bridge";
import {
  editorExportRequestSchema,
  editorExportResultSchema,
  presenceSchema,
  readRoomMessage,
} from "./protocol";
const request = () =>
  editorExportRequestSchema.parse({
    type: "export_request",
    requestId: crypto.randomUUID(),
    expectedRevision: 1,
    pageId: "page-1",
    ids: ["frame"],
    format: "png",
    scale: 1,
    mode: "selection",
  });
const result = (requestId: string) =>
  editorExportResultSchema.parse({
    type: "export_result",
    requestId,
    revision: 1,
    files: [{ name: "Frame.png", mimeType: "image/png", base64: "aGVsbG8=" }],
    warnings: [],
  });
test("editor exports are solicited, bounded and bound to the selected socket", async () => {
  const bridge = new EditorBridge(),
    input = request();
  let sent = false;
  const pending = bridge.request("mine", input, () => {
    sent = true;
  });
  expect(sent).toBe(true);
  expect(bridge.waiting("mine")).toBe(true);
  expect(bridge.receive("other", result(input.requestId))).toBe(false);
  expect(bridge.receive("mine", result(crypto.randomUUID()))).toBe(false);
  expect(
    bridge.receive("mine", {
      ...result(input.requestId),
      files: [{ name: "x", mimeType: "text/html", base64: "AA==" }],
    }),
  ).toBe(false);
  expect(bridge.receive("mine", result(input.requestId))).toBe(true);
  expect(await pending).toEqual(result(input.requestId));
  expect(bridge.receive("mine", result(input.requestId))).toBe(false);
  expect(bridge.waiting("mine")).toBe(false);
});
test("editor bridge releases failed sends and bounds concurrent requests", async () => {
  const bridge = new EditorBridge();
  await expect(
    bridge.request("mine", request(), () => {
      throw new Error("closed");
    }),
  ).rejects.toThrow("disconnected");
  expect(bridge.waiting("mine")).toBe(false);
  const inputs = [request(), request(), request()];
  const pending = inputs.map((input) => bridge.request("mine", input, () => {}));
  expect(() => bridge.request("mine", request(), () => {})).toThrow("in progress");
  for (const input of inputs) bridge.receive("mine", result(input.requestId));
  await Promise.all(pending);
});
test("editor protocol rejects excessive work and non-data export payloads", () => {
  const input = request();
  expect(readRoomMessage(JSON.stringify(input))).toEqual(input);
  for (const patch of [
    { ids: [] },
    { ids: Array(51).fill("node") },
    { format: "html" },
    { scale: 10 },
    { expectedRevision: -1 },
    { url: "http://localhost/private" },
  ])
    expect(editorExportRequestSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  expect(
    editorExportResultSchema.safeParse({
      ...result(input.requestId),
      files: [{ name: "x", mimeType: "image/png", base64: "?" }],
    }).success,
  ).toBe(false);
  const presence = {
    pageId: "page-1",
    cursor: null,
    selectedIds: [],
    action: null,
    away: false,
    preview: null,
  };
  expect(
    presenceSchema.safeParse({
      ...presence,
      viewport: { x: 1, y: 2, zoom: 1, width: 100, height: 200 },
    }).success,
  ).toBe(true);
  expect(
    presenceSchema.safeParse({
      ...presence,
      viewport: { x: 1, y: 2, zoom: 0, width: 100, height: 200 },
    }).success,
  ).toBe(false);
});

test("editor timeouts and disconnects retire their request without accepting late bytes", async () => {
  const bridge = new EditorBridge(5),
    input = request();
  await expect(bridge.request("mine", input, () => {})).rejects.toThrow("timed out");
  expect(bridge.waiting("mine")).toBe(false);
  expect(bridge.receive("mine", result(input.requestId))).toBe(false);
  const next = request(),
    pending = bridge.request("mine", next, () => {});
  bridge.disconnect("mine");
  await expect(pending).rejects.toThrow("disconnected");
  expect(bridge.waiting("mine")).toBe(false);
});

test("editor context excludes other users, closed sessions, away and stale peers", () => {
  const now = Date.now();
  const peer = (userId: string, sessionId: string, updatedAt = now, away = false) => ({
    pageId: "page-1",
    cursor: null,
    selectedIds: [`${userId}-selection`],
    action: null,
    away,
    preview: null,
    userId,
    sessionId,
    name: "private name",
    image: null,
    color: "#000000",
    updatedAt,
  });
  const peers = [
    peer("mine", "active"),
    peer("other", "other"),
    peer("mine", "closed"),
    peer("mine", "away", now, true),
    peer("mine", "stale", now - 90001),
  ];
  const contexts = ownEditorSessions(
    peers,
    new Set(["active", "other", "away", "stale"]),
    "mine",
    now,
  );
  expect(contexts).toEqual([
    {
      sessionId: "active",
      pageId: "page-1",
      selectedIds: ["mine-selection"],
      viewport: null,
      updatedAt: now,
    },
  ]);
  expect(JSON.stringify(contexts)).not.toContain("other-selection");
  expect(JSON.stringify(contexts)).not.toContain("private name");
});
