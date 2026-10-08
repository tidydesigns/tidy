import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  type DesignNode,
} from "../document";
export const exportImageId = "00000000-0000-4000-8000-000000000038";
export const exportMaskImageId = "00000000-0000-4000-8000-000000000039";
export function buildExportDocument() {
  const node = (
    id: string,
    type: DesignNode["type"],
    parentId: string | null,
    x: number,
    y: number,
    width: number,
    height: number,
    extra: Partial<DesignNode> = {},
  ): DesignNode => ({
    ...buildDrawnNode(id, type === "image" || type === "vector" ? "container" : type, parentId, {
      x,
      y,
      width,
      height,
    }),
    type,
    positionMode: "absolute",
    style: {},
    ...extra,
  });
  return parseDesignDocument({
    ...blankDesignDocument(),
    designTokens: { pathColor: { type: "color", value: "#0088cc" } },
    nodes: [
      node("frame", "artboard", null, 40, 40, 620, 420, {
        name: "Export frame",
        style: { fill: "#ffffff" },
      }),
      node("gradient", "container", "frame", 30, 30, 240, 110, {
        name: "Gradient panel",
        style: {
          radius: 18,
          rotation: 7,
          paints: [
            {
              id: "gradient-fill",
              type: "linear",
              angle: 90,
              opacity: 1,
              visible: true,
              stops: [
                { id: "start", position: 0, color: "#ff6600" },
                { id: "end", position: 1, color: "#ffee00" },
              ],
            },
          ],
          borderWidth: 3,
          borderColor: "#111111",
        },
      }),
      node("heading", "text", "gradient", 18, 30, 190, 48, {
        name: "Web font heading",
        text: "Native export",
        style: {
          fontFamily: "Roboto",
          fontSource: "web",
          fontSize: 24,
          color: "#111111",
          fontWeight: 400,
          lineHeight: 1.2,
        },
      }),
      node("paragraph", "text", "frame", 310, 35, 270, 90, {
        name: "Wrapped text",
        text: "A second font wraps across two lines.\nAnother paragraph.",
        style: {
          fontFamily: "monospace",
          fontSize: 17,
          color: "#222222",
          lineHeight: 1.4,
          paragraphSpacing: 7,
        },
      }),
      node("crop", "image", "frame", 30, 175, 160, 100, {
        name: "Cropped image",
        assetId: exportImageId,
        style: {
          objectFit: "cover",
          radius: 12,
          imageCrop: {
            x: 0.2,
            y: 0.1,
            width: 0.5,
            height: 0.6,
            sourceWidth: 400,
            sourceHeight: 200,
          },
        },
      }),
      node("path", "vector", "frame", 235, 175, 140, 100, {
        name: "Native path",
        assetId: exportImageId,
        vectorPath: {
          d: "M10 90L70 5L130 90Z",
          viewBox: { x: 0, y: 0, width: 140, height: 100 },
          fillRule: "nonzero",
        },
        style: {
          fill: "#ff0000",
          fillToken: "pathColor",
          borderWidth: 4,
          borderColor: "#111111",
          strokeJoin: "round",
        },
      }),
      node("filtered", "container", "frame", 420, 175, 130, 100, {
        name: "Filtered shape",
        style: {
          fill: "#3388cc",
          radius: 15,
          effects: [
            { id: "blur", type: "blur", amount: 2, visible: true },
            { id: "brightness", type: "brightness", amount: 115, visible: true },
          ],
        },
      }),
      node("image-fill", "container", "frame", 30, 310, 160, 80, {
        name: "Image fill",
        style: {
          radius: 10,
          paints: [
            {
              id: "image-fill",
              type: "image",
              assetId: exportImageId,
              fit: "cover",
              positionX: 25,
              positionY: 50,
              opacity: 1,
              visible: true,
            },
          ],
        },
      }),
      node("mask-asset", "image", "frame", 235, 305, 140, 85, {
        name: "Masked SVG asset",
        assetId: exportMaskImageId,
        style: { objectFit: "fill" },
      }),
      node("frame-two", "artboard", null, 800, 40, 300, 180, {
        name: "Export frame",
        style: { fill: "#f2f2f0" },
      }),
      node("second-text", "text", "frame-two", 30, 25, 240, 60, {
        name: "Second frame text",
        text: "Batch export",
        style: { fontFamily: "monospace", fontSize: 22, color: "#111111", maxLines: 1 },
      }),
    ],
  });
}
