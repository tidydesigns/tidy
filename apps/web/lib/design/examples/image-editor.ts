import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "../document";
export const imageEditorAssetId = "00000000-0000-4000-8000-000000000071";
export function buildImageEditorDocument() {
  return parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      {
        ...buildDrawnNode("image-study", "artboard", null, {
          x: 80,
          y: 80,
          width: 720,
          height: 620,
        }),
        name: "Image study",
        style: { fill: "#f8f6f1" },
      },
      {
        ...buildDrawnNode("image-heading", "text", "image-study", {
          x: 48,
          y: 38,
          width: 620,
          height: 45,
        }),
        name: "Heading",
        text: "A quieter perspective.",
        style: { fontFamily: "Georgia", fontSize: 32, color: "#33413e" },
      },
      {
        ...buildDrawnNode("landscape", "container", "image-study", {
          x: 48,
          y: 112,
          width: 624,
          height: 380,
        }),
        type: "image",
        name: "Landscape",
        assetId: imageEditorAssetId,
        style: { objectFit: "cover", radius: 8 },
      },
      {
        ...buildDrawnNode("image-caption", "text", "image-study", {
          x: 48,
          y: 522,
          width: 624,
          height: 32,
        }),
        name: "Caption",
        text: "FIELD NOTES     /     THE NORTHERN COAST",
        style: { fontSize: 12, letterSpacing: 2, color: "#69776f" },
      },
    ],
  });
}
