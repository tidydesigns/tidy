import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TidyDesign } from "@tidy/design-renderer/design";
import type { CanvasSnapshot } from "./canvas-service";

export function canvasMarkup(
  snapshot: Pick<CanvasSnapshot, "document" | "rootId" | "assets" | "width">,
) {
  const markup = renderToStaticMarkup(
    createElement(TidyDesign, {
      document: snapshot.document,
      rootId: snapshot.rootId,
      assets: snapshot.assets,
      frameWidth: snapshot.width,
      readOnly: true,
    }),
  );
  if (Buffer.byteLength(markup) > 12 * 1024 * 1024)
    throw new Error("Preview markup exceeds the rendering limit.");
  return markup;
}
