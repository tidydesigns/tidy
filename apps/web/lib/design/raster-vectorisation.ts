import { parseDesignDocument, type DesignDocument, type DesignNode } from "./document";
import { isLayerLocked, isLayerVisible } from "./edit-document";
import { imageViewport } from "./image-viewport";
import { traceLimits, type RasterTrace } from "./raster-trace-contract";

export function vectorisationUnavailable(document: DesignDocument, node: DesignNode) {
  if (node.type !== "image" || !node.assetId || node.vectorPath || node.vectorBoolean)
    return "Choose a raster image layer.";
  if (isLayerLocked(document.nodes, node.id) || !isLayerVisible(document.nodes, node.id))
    return "Unlock and show the image first.";
  if (document.assetMimeTypes?.[node.assetId] === "image/svg+xml")
    return "This image is already an SVG.";
  if (document.nodes.some((child) => child.parentId === node.id))
    return "Choose an image without child layers.";
  let current: DesignNode | undefined = node;
  const byId = new Map(document.nodes.map((n) => [n.id, n]));
  while (current) {
    if (
      current.isComponent ||
      current.instanceOf ||
      current.componentSourceId ||
      current.librarySource ||
      current.variants
    )
      return "Detach the image from its component before vectorising.";
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  if (node.styleId) return "Detach the image's reusable style before vectorising.";
}

/** Ignore moves/names, but fence every source, crop, sizing and style change during tracing. */
export function vectorisationSource(node: DesignNode) {
  return JSON.stringify({
    assetId: node.assetId,
    width: node.box.width,
    height: node.box.height,
    style: node.style,
    padding: node.padding,
    paddingLeft: node.paddingLeft,
    paddingRight: node.paddingRight,
    paddingTop: node.paddingTop,
    paddingBottom: node.paddingBottom,
  });
}

export function applyRasterTrace(
  document: DesignDocument,
  nodeId: string,
  expectedSource: string,
  trace: RasterTrace,
  makeId = () => crypto.randomUUID(),
): DesignDocument {
  const node = document.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("The image was removed while vectorising.");
  const unavailable = vectorisationUnavailable(document, node);
  if (unavailable) throw new Error(unavailable);
  if (vectorisationSource(node) !== expectedSource)
    throw new Error("The image changed while vectorising. Try again with the current image.");
  if (
    !trace.paths.length ||
    trace.paths.length > traceLimits.paths ||
    document.nodes.length + trace.paths.length > 5000
  )
    throw new Error("There is not enough layer capacity for this trace.");
  const viewport = imageViewport(node);
  const children = trace.paths.map((path, index): DesignNode => {
    const points = path.vectorPath.contours!.flatMap((contour) =>
      contour.points.flatMap((point) => [
        point,
        ...(point.in ? [point.in] : []),
        ...(point.out ? [point.out] : []),
      ]),
    );
    const x = Math.min(...points.map((point) => point.x)),
      y = Math.min(...points.map((point) => point.y));
    const width = Math.max(0.01, Math.max(...points.map((point) => point.x)) - x),
      height = Math.max(0.01, Math.max(...points.map((point) => point.y)) - y);
    return {
      id: makeId(),
      name: path.name ?? `Shape ${index + 1}`,
      parentId: node.id,
      pageId: node.pageId,
      type: "vector",
      box: {
        x: (node.paddingLeft ?? node.padding ?? 0) + (x * viewport.width) / trace.width,
        y: (node.paddingTop ?? node.padding ?? 0) + (y * viewport.height) / trace.height,
        width: (width * viewport.width) / trace.width,
        height: (height * viewport.height) / trace.height,
      },
      layout: "absolute",
      positionMode: "absolute",
      horizontalConstraint: "scale",
      verticalConstraint: "scale",
      vectorPath: { ...path.vectorPath, viewBox: { x, y, width, height } },
      style: {
        paints: [
          {
            id: "trace-fill",
            type: "solid",
            color: path.color,
            opacity: path.opacity,
            visible: true,
          },
        ],
      },
      visible: true,
      locked: false,
    };
  });
  const style = { ...node.style };
  delete style.imageCrop;
  delete style.imageAdjustments;
  delete style.objectFit;
  delete style.objectPositionX;
  delete style.objectPositionY;
  delete style.objectScale;
  // The same node retains its identity, outer style, parent, position, comments and interactions.
  const root: DesignNode = {
    ...node,
    type: "container",
    assetId: undefined,
    layout: "absolute",
    style: { ...style, overflow: "hidden" },
  };
  const index = document.nodes.indexOf(node);
  return parseDesignDocument({
    ...document,
    nodes: [
      ...document.nodes.slice(0, index),
      root,
      ...children,
      ...document.nodes.slice(index + 1),
    ],
  });
}
