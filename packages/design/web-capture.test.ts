import { describe, expect, test } from "bun:test";
import { blankDesignDocument, type DesignNode } from "./document";
import { captureSourceUrl, webCaptureSchema } from "./web-capture";

const frame: DesignNode = {
  id: "frame",
  parentId: null,
  name: "Page",
  type: "artboard",
  box: { x: 0, y: 0, width: 800, height: 600 },
  style: {},
  layout: "absolute",
  locked: false,
  visible: true,
};
const capture = () => ({
  title: "Page",
  url: "https://example.com/page",
  mode: "page",
  document: { ...blankDesignDocument(), nodes: [frame] },
  assets: [],
});

describe("web capture boundary", () => {
  test("removes credentials and URL tokens from source metadata", () => {
    expect(captureSourceUrl("https://user:secret@example.com/page?token=secret#private")).toBe(
      "https://example.com/page",
    );
    expect(
      webCaptureSchema.safeParse({ ...capture(), url: "https://example.com?token=secret" }).success,
    ).toBe(false);
    expect(webCaptureSchema.safeParse({ ...capture(), url: "javascript:alert(1)" }).success).toBe(
      false,
    );
  });
  test("requires a structurally valid editable frame", () => {
    expect(webCaptureSchema.parse(capture()).document.nodes[0].type).toBe("artboard");
    expect(
      webCaptureSchema.safeParse({ ...capture(), document: blankDesignDocument() }).success,
    ).toBe(false);
    expect(
      webCaptureSchema.safeParse({
        ...capture(),
        document: { ...blankDesignDocument(), nodes: [frame, frame] },
      }).success,
    ).toBe(false);
  });
  test("rejects asset references not supplied in this capture", () => {
    const document = {
      ...blankDesignDocument(),
      nodes: [
        frame,
        {
          ...frame,
          id: "image",
          type: "image",
          parentId: frame.id,
          assetId: "00000000-0000-4000-8000-000000000001",
        },
      ],
    };
    expect(webCaptureSchema.safeParse({ ...capture(), document }).success).toBe(false);
  });
});
