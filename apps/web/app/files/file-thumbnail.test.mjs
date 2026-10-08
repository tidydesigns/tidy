import { FileThumbnail } from "@/app/files/file-thumbnail";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ThumbnailRenderer } from "@/app/files/thumbnail-renderer";
import { buildLoginDocument } from "@/lib/design/examples/login";
import { blankDesignDocument } from "@/lib/design/document";

test("fallback thumbnail renderer preserves the UI preview", () => {
  const document = buildLoginDocument("00000000-0000-4000-8000-000000000001");
  const html = renderToStaticMarkup(
    createElement(ThumbnailRenderer, {
      fileId: "example",
      snapshot: { document: { content: document }, frames: [], rectangles: [] },
    }),
  );
  expect(html).toContain("<svg");
  expect(html).toContain("Welcome back.");
  expect(html).toContain("Tidy");
  expect(html).not.toContain("border-dashed");
});

test("fallback thumbnail renderer preserves legacy shapes", () => {
  const html = renderToStaticMarkup(
    createElement(ThumbnailRenderer, {
      fileId: "example",
      snapshot: {
        document: null,
        frames: [{ id: "frame", x: 10, y: 20, width: 300, height: 200 }],
        rectangles: [],
      },
    }),
  );
  expect(html).toContain("<svg");
  expect(html).toContain('width="300"');
  expect(html).not.toContain("border-dashed");
});

test("fallback thumbnail renderer includes shapes drawn outside frames", () => {
  const document = blankDesignDocument();
  document.nodes.push({
    id: "free-rectangle",
    parentId: null,
    name: "Free rectangle",
    type: "container",
    box: { x: 1800, y: 100, width: 120, height: 80 },
    style: { fill: "#dedede" },
    visible: true,
    locked: false,
    layout: "absolute",
  });
  const html = renderToStaticMarkup(
    createElement(ThumbnailRenderer, {
      fileId: "example",
      snapshot: { document: { content: document }, frames: [], rectangles: [] },
    }),
  );
  expect(html).toContain('viewBox="');
  expect(html).toContain("background:#dedede");
  expect(html).toContain("left:24px;top:24px");
});

test("an empty editable file uses the neutral placeholder", () => {
  const html = renderToStaticMarkup(
    createElement(ThumbnailRenderer, {
      fileId: "example",
      snapshot: {
        document: { content: blankDesignDocument() },
        frames: [],
        rectangles: [],
      },
    }),
  );
  expect(html).not.toContain("<svg");
});

test("deleted legacy shapes do not reappear in a converted file card", () => {
  const html = renderToStaticMarkup(
    createElement(ThumbnailRenderer, {
      fileId: "example",
      snapshot: {
        document: { content: blankDesignDocument() },
        frames: [{ id: "old-frame", x: 10, y: 20, width: 300, height: 200 }],
        rectangles: [],
      },
    }),
  );
  expect(html).not.toContain("<svg");
  expect(html).not.toContain("<svg");
});

test("thumbnail uses the same flex layout and tokens as the editor", () => {
  const document = blankDesignDocument();
  document.tokens.brand = "#aabbcc";
  document.nodes.push({
    id: "frame",
    parentId: null,
    name: "Frame",
    type: "artboard",
    box: { x: 0, y: 0, width: 300, height: 200 },
    style: { fillToken: "brand" },
    visible: true,
    locked: false,
    layout: "flex-column",
    gap: 12,
    padding: 16,
  });
  document.nodes.push({
    id: "text",
    parentId: "frame",
    name: "Title",
    type: "text",
    text: "Hello",
    box: { x: 20, y: 20, width: 100, height: 30 },
    style: {},
    visible: true,
    locked: false,
    layout: "absolute",
  });
  const html = renderToStaticMarkup(
    createElement(ThumbnailRenderer, {
      fileId: "example",
      snapshot: { document: { content: document }, frames: [], rectangles: [] },
    }),
  );
  expect(html).toContain("display:flex");
  expect(html).toContain("flex-direction:column");
  expect(html).toContain("background:#aabbcc");
  expect(html).toContain("Hello");
});

test("cached file cards render a single image without document nodes", () => {
  const html = renderToStaticMarkup(
    createElement(FileThumbnail, {
      fileId: "example",
      initialVersion: "3:2026-10-03T00:00:00.000Z",
      thumbnailVersion: "png-v2:3:2026-10-03T00:00:00.000Z",
      eager: true,
    }),
  );
  expect(html).toContain("<img");
  expect(html).toContain("/api/files/example/thumbnail");
  expect(html).not.toContain("<svg");
  expect(html).not.toContain("foreignObject");
});
test("uncached file cards defer document rendering until observed", () => {
  const html = renderToStaticMarkup(
    createElement(FileThumbnail, {
      fileId: "example",
      initialVersion: "3:2026-10-03T00:00:00.000Z",
      thumbnailVersion: null,
    }),
  );
  expect(html).toContain("border-dashed");
  expect(html).not.toContain("<svg");
});

test("cached cards outside the initial viewport defer image requests too", () => {
  const html = renderToStaticMarkup(
    createElement(FileThumbnail, {
      fileId: "offscreen",
      initialVersion: "3:2026-10-03T00:00:00.000Z",
      thumbnailVersion: "png-v2:3:2026-10-03T00:00:00.000Z",
    }),
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<svg");
});
