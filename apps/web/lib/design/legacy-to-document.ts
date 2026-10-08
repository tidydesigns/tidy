import { blankDesignDocument, buildDrawnNode, type DesignDocument } from "./document";
import type { DesignFrame, DesignRectangle } from "./service";

/** Preserve legacy coordinates and IDs while moving old files into the single editor. */
export function legacyToDocument(
  frames: DesignFrame[],
  rectangles: DesignRectangle[],
): DesignDocument {
  const document = blankDesignDocument();
  document.nodes = [
    ...frames.map((frame) => ({
      ...buildDrawnNode(frame.id, "artboard", null, frame),
      name: "Frame",
    })),
    ...rectangles.map((rectangle) => ({
      ...buildDrawnNode(rectangle.id, "container", null, rectangle),
      name: "Rectangle",
    })),
  ];
  return document;
}
