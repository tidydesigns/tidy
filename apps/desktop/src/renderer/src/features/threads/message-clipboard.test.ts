import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "../../../../main/workspace/project-store";
import {
  clipboardClientId,
  readMessageClipboard,
  MESSAGE_CLIPBOARD_MIME,
  decodeMessageClipboard,
  importMessageAttachment,
  messageClipboardContent,
  messageClipboardText,
} from "./message-clipboard";

const clientId = "aa6ea601-6dbb-4ea5-bb1a-218dd938d5ed";
const projectId = "072b8a38-9094-4c6f-9dbb-9cc4ae6ab71b";
const file = {
  id: "182eaa26-4c79-4ab4-934c-cbb1674272f4",
  name: 'Reference "image".png',
  mimeType: "image/png",
  size: 3,
};
const content = () =>
  messageClipboardContent({
    message: { text: `Use [[attachment:${file.id}]]`, attachments: [file] },
    clientId,
    projectId,
  });
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("plain text resolves inline references and includes image-only attachments", () => {
  expect(messageClipboardText({ text: `Use [[attachment:${file.id}]]`, attachments: [file] })).toBe(
    `Use ${file.name}`,
  );
  expect(messageClipboardText({ text: "Compare", attachments: [file] })).toBe(
    `Compare\n${file.name}`,
  );
  expect(messageClipboardText({ text: "", attachments: [file] })).toBe(file.name);
});

test("clipboard carries bounded attachment references without image bytes or preview URLs", () => {
  const value = content();
  const decoded = decodeMessageClipboard(value.encoded);
  expect(decoded?.attachments).toEqual([file]);
  expect(decoded?.source).toEqual({ clientId, projectId, machineId: "local" });
  expect(value.html).toContain("data-tidy-message=");
  expect(value.html).not.toContain("data:image");
  expect(value.html).not.toContain("<img");
  const preview = { ...file, previewUrl: "data:image/png;base64,AQID" };
  const withPreview = messageClipboardContent({
    message: {
      text: "Image",
      attachments: [preview],
    },
    clientId,
    projectId,
  });
  expect(withPreview.encoded).not.toContain("previewUrl");
});

test("HTML fallback escapes message content", () => {
  const value = messageClipboardContent({
    message: { text: '<script>alert("copy")</script>', attachments: [file] },
    clientId,
    projectId,
  });
  expect(value.html).not.toContain("<script>");
  expect(value.html).toContain("&lt;script&gt;");
});

test("malformed, embedded-byte, duplicate, and oversized fragments are rejected", () => {
  const valid = decodeMessageClipboard(content().encoded);
  if (!valid) throw new Error("Valid fixture was rejected");
  for (const fragment of [
    { ...valid, version: 2 },
    { ...valid, attachments: [{ ...file, dataUrl: "data:image/png;base64,AQID" }] },
    { ...valid, attachments: [file, file] },
    { ...valid, source: { ...valid.source, projectId: "../../other-project" } },
    { ...valid, attachments: Array.from({ length: 11 }, () => file) },
    {
      ...valid,
      attachments: [
        { ...file, size: 20 * 1024 * 1024 },
        { ...file, id: crypto.randomUUID(), size: 20 * 1024 * 1024 },
      ],
    },
  ])
    expect(decodeMessageClipboard(JSON.stringify(fragment))).toBeNull();
  expect(decodeMessageClipboard("{")).toBeNull();
  expect(decodeMessageClipboard(" ".repeat(1_100_001))).toBeNull();
});

async function storageFixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-message-copy-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(join(root, "state"));
  await store.initialize();
  await mkdir(join(root, "source"));
  await mkdir(join(root, "destination"));
  const { project: source } = await store.open(join(root, "source"));
  const { project: destination } = await store.open(join(root, "destination"));
  const image = await store.addAttachment(
    source.id,
    "layout.png",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSkcAAAAASUVORK5CYII=",
  );
  const value = messageClipboardContent({
    message: { text: "Image", attachments: [image] },
    clientId,
    projectId: source.id,
  });
  const message = decodeMessageClipboard(value.encoded);
  if (!message) throw new Error("Fixture clipboard was rejected");
  const api = {
    exportAttachment: async (projectId: string, attachmentId: string) => {
      const file = await store.resolveAttachment(projectId, attachmentId);
      return {
        name: file.name,
        dataUrl: `data:${file.mimeType};base64,${(await readFile(file.path)).toString("base64")}`,
      };
    },
    addAttachment: store.addAttachment.bind(store),
  };
  return { store, source, destination, image, message, api };
}

test("pasting imports actual bytes into the destination project under a fresh ID", async () => {
  const { store, destination, image, message, api } = await storageFixture();
  const result = await importMessageAttachment({
    source: api,
    target: api,
    message,
    file: image,
    projectId: destination.id,
    signal: new AbortController().signal,
  });
  expect(result.id).not.toBe(image.id);
  expect(result.name).toBe(image.name);
  expect((await store.readAttachment(destination.id, result.id)).previewUrl).toBe(image.previewUrl);
});

test("removing an attachment during export prevents a destination import", async () => {
  const { destination, image, message, api } = await storageFixture();
  const controller = new AbortController();
  await expect(
    importMessageAttachment({
      source: {
        exportAttachment: async (...args) => {
          const value = await api.exportAttachment(...args);
          controller.abort();
          return value;
        },
      },
      target: {
        addAttachment: async () => {
          throw new Error("Destination must not be called");
        },
      },
      message,
      file: image,
      projectId: destination.id,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("forged attachment metadata is rejected before importing bytes", async () => {
  const { destination, image, message, api } = await storageFixture();
  await expect(
    importMessageAttachment({
      source: api,
      target: api,
      message,
      file: { ...image, size: 1 },
      projectId: destination.id,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("no longer matches");
});

test("custom clipboard and HTML fallback restore the same references", () => {
  const value = messageClipboardContent({
    message: { text: "Image", attachments: [file] },
    projectId,
    clientId: clipboardClientId(),
  });
  for (const custom of [true, false]) {
    const data = {
      getData: (type: string) =>
        type === "text/plain"
          ? value.text
          : type === "text/html"
            ? value.html
            : custom && type === MESSAGE_CLIPBOARD_MIME
              ? value.encoded
              : "",
    };
    expect(readMessageClipboard(data)?.attachments).toEqual([file]);
  }
});

test("pasted excerpts and foreign-client references fall back to ordinary text", () => {
  const value = content();
  const getData = (type: string) =>
    type === MESSAGE_CLIPBOARD_MIME
      ? value.encoded
      : type === "text/html"
        ? value.html
        : value.text;
  expect(readMessageClipboard({ getData })).toBeNull();
  const local = messageClipboardContent({
    message: { text: "Original message", attachments: [file] },
    projectId,
  });
  expect(
    readMessageClipboard({
      getData: (type) => (type === "text/html" ? local.html : "Selected excerpt"),
    }),
  ).toBeNull();
});

test("replacing the draft attachments while an export is pending prevents an import", async () => {
  const { destination, image, message, api } = await storageFixture();
  let retained = true;
  await expect(
    importMessageAttachment({
      source: {
        exportAttachment: async (...args) => {
          const value = await api.exportAttachment(...args);
          retained = false;
          return value;
        },
      },
      target: {
        addAttachment: async () => {
          throw new Error("Destination must not be called");
        },
      },
      message,
      file: image,
      projectId: destination.id,
      signal: new AbortController().signal,
      isRetained: () => retained,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
