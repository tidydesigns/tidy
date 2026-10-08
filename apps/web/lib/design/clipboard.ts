import { mapNodeStyles } from "./node-styles";
import {
  componentSubtreeIds,
  remapComponentProperties,
  remapComponentVariants,
} from "./component-variants";
import * as z from "zod";
import { remapInteractions } from "@bella/design/prototype";
import {
  blankDesignDocument,
  designNodeSchema,
  nodeAssetIds,
  nodePageId,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
} from "./document";
import { editLayers, isLayerLocked, isLayerVisible } from "./edit-document";
import { reparentGeometry, type MeasuredBoxes } from "./reparent-geometry";
import {
  designTokensSchema,
  mapTokenBindings,
  resolvedDocumentNodes,
  bindingKinds,
  bindingPath,
  type TokenBinding,
} from "./design-tokens";
import { importTokenDefinitions } from "./tokens";

const payloadSchema = z
  .object({
    bellaClipboard: z.literal(1),
    kind: z.enum(["layers", "properties"]),
    sourceFile: z.string().max(120),
    nodes: z.array(designNodeSchema).min(1).max(5000),
    resolvedNodes: z.array(designNodeSchema).max(5000).optional(),
    tokens: z.record(z.string(), z.string()).default({}),
    designTokens: designTokensSchema.optional(),
  })
  .strict();
export type DesignClipboard = z.infer<typeof payloadSchema>;

export function copyLayers(
  document: DesignDocument,
  ids: string[],
  sourceFile: string,
  boxes?: MeasuredBoxes,
): string {
  const selected = new Set(ids);
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const roots = document.nodes
    .filter((node) => selected.has(node.id))
    .filter((node) => {
      let parent = node.parentId;
      while (parent) {
        if (selected.has(parent)) return false;
        parent = byId.get(parent)?.parentId ?? null;
      }
      return true;
    });
  if (!roots.length) throw new Error("Select layers to copy.");
  const copied = new Set(roots.map((node) => node.id));
  for (let expanded = true; expanded;) {
    expanded = false;
    for (const node of document.nodes)
      if (node.parentId && copied.has(node.parentId) && !copied.has(node.id)) {
        copied.add(node.id);
        expanded = true;
      }
  }
  for (const node of document.nodes.filter((n) => copied.has(n.id) && n.instanceOf)) {
    const master = byId.get(node.instanceOf!);
    if (master?.librarySource)
      for (const id of componentSubtreeIds(document.nodes, master.id)) copied.add(id);
  }
  const rootIds = new Set([
    ...roots.map((node) => node.id),
    ...document.nodes.filter((n) => copied.has(n.id) && n.librarySource).map((n) => n.id),
  ]);
  const bases = resolvedDocumentNodes(document, new Map(), copied);
  const resolved = resolvedDocumentNodes(document);
  const placeRoot = (node: DesignNode) =>
    rootIds.has(node.id)
      ? {
          ...node,
          ...reparentGeometry(resolved, node, null, boxes),
          parentId: null,
          widthMode: "fixed" as const,
          heightMode: "fixed" as const,
          horizontalConstraint: "start" as const,
          verticalConstraint: "start" as const,
        }
      : node;
  return JSON.stringify({
    bellaClipboard: 1,
    kind: "layers",
    sourceFile,
    tokens: document.tokens,
    designTokens: document.designTokens,
    resolvedNodes: resolved.filter((node) => copied.has(node.id) && node.instanceOf).map(placeRoot),
    nodes: bases.filter((node) => copied.has(node.id)).map(placeRoot),
  });
}

export function copyProperties(
  node: DesignNode,
  document: DesignDocument,
  sourceFile: string,
): string {
  return JSON.stringify({
    bellaClipboard: 1,
    kind: "properties",
    sourceFile,
    tokens: document.tokens,
    designTokens: document.designTokens,
    nodes: [
      {
        ...(resolvedDocumentNodes(document).find((item) => item.id === node.id) ?? node),
        parentId: null,
        variants: undefined,
        variant: undefined,
        componentProperties: undefined,
        librarySource: undefined,
        styleId: undefined,
        styleOverrides: undefined,
      },
    ],
  });
}

export function readDesignClipboard(text: string): DesignClipboard | null {
  if (text.length > 2_000_000) return null;
  try {
    const payload = payloadSchema.parse(JSON.parse(text));
    // Validate hierarchy independently of links that may refer to the source file.
    parseDesignDocument({
      ...blankDesignDocument(),
      tokens: payload.tokens,
      designTokens: payload.designTokens,
      nodes: payload.nodes.map((node) => ({
        ...node,
        variants: undefined,
        variant: undefined,
        componentProperties: undefined,
        librarySource: undefined,
        styleId: undefined,
        styleOverrides: undefined,
        pageId: "page-1",
        linkTo: payload.nodes.some((item) => item.id === node.linkTo) ? node.linkTo : undefined,
        // Validate interaction references after the family and destination file are resolved on paste.
        interactions: undefined,
      })),
    });
    return payload;
  } catch {
    return null;
  }
}

function importTokens(document: DesignDocument, payload: DesignClipboard) {
  const referenced = new Set<string>();
  for (const node of [...payload.nodes, ...(payload.resolvedNodes ?? [])])
    mapNodeStyles(node, (style) => {
      for (const token of [style.fillToken, style.colorToken, style.borderColorToken])
        if (token) referenced.add(token);
      for (const paint of [...(style.paints ?? []), ...(style.strokePaints ?? [])]) {
        if (paint.type === "solid" && paint.token) referenced.add(paint.token);
        if (paint.type === "linear" || paint.type === "radial")
          for (const stop of paint.stops) if (stop.token) referenced.add(stop.token);
      }
      return style;
    });
  for (const node of [...payload.nodes, ...(payload.resolvedNodes ?? [])])
    mapTokenBindings(node, (name) => {
      referenced.add(name);
      return name;
    });
  return importTokenDefinitions(document, payload, referenced);
}

export function pasteLayers(
  document: DesignDocument,
  payload: DesignClipboard,
  options: {
    fileId: string;
    pageId: string;
    parentId: string | null;
    inPlace?: boolean;
    createId: () => string;
    boxes?: MeasuredBoxes;
  },
): { document: DesignDocument; ids: string[] } {
  if (payload.kind !== "layers") throw new Error("The clipboard does not contain layers.");
  const ids = new Map(payload.nodes.map((node) => [node.id, options.createId()]));
  const imported = importTokens(document, payload);
  const sameFile = options.fileId === payload.sourceFile;
  const existing = new Map(document.nodes.map((node) => [node.id, node]));
  const libraryIds = new Set<string>();
  for (const n of payload.nodes.filter((n) => n.librarySource))
    for (const id of componentSubtreeIds(payload.nodes, n.id)) libraryIds.add(id);
  const roots = payload.nodes.filter((node) => node.parentId === null);
  const parent = options.parentId ? existing.get(options.parentId) : undefined;
  if (
    options.parentId &&
    (!parent ||
      nodePageId(parent) !== options.pageId ||
      !["artboard", "container"].includes(parent.type))
  ) {
    throw new Error("Choose a frame or container on this page to paste into.");
  }
  if (
    parent &&
    (isLayerLocked(document.nodes, parent.id) || !isLayerVisible(document.nodes, parent.id))
  ) {
    throw new Error("Unlock and show the target frame before pasting layers into it.");
  }
  const renderedTarget = resolvedDocumentNodes(document);
  const nodes = payload.nodes.map((node): DesignNode => {
    const root = node.parentId === null;
    const hasMaster =
      node.instanceOf && (ids.has(node.instanceOf) || (sameFile && existing.has(node.instanceOf)));
    const detached = Boolean(node.instanceOf && !hasMaster);
    const appearance = detached
      ? (payload.resolvedNodes?.find((item) => item.id === node.id) ?? node)
      : node;
    const styled = imported.node(appearance);
    const parentId = root
      ? node.type === "artboard"
        ? null
        : node.librarySource
          ? null
          : options.parentId
      : ids.get(node.parentId!)!;
    const geometrySource =
      root && hasMaster
        ? imported.node(payload.resolvedNodes?.find((item) => item.id === node.id) ?? appearance)
        : styled;
    const placementBox = {
      ...geometrySource.box,
      x: geometrySource.box.x + (options.inPlace ? 0 : 24),
      y: geometrySource.box.y + (options.inPlace ? 0 : 24),
    };
    const placed = root
      ? reparentGeometry(
          renderedTarget,
          { ...geometrySource, parentId: null, box: placementBox },
          parentId,
          options.boxes,
          placementBox,
        )
      : null;
    const link = node.linkTo
      ? (ids.get(node.linkTo) ??
        (sameFile && existing.get(node.linkTo)?.type === "artboard" ? node.linkTo : undefined))
      : undefined;
    return {
      ...styled,
      id: ids.get(node.id)!,
      pageId: libraryIds.has(node.id) ? "library-components" : options.pageId,
      parentId,
      ...(placed
        ? {
            ...placed,
            positionMode: "absolute" as const,
            widthMode: "fixed" as const,
            heightMode: "fixed" as const,
            horizontalConstraint: "start" as const,
            verticalConstraint: "start" as const,
          }
        : {}),
      variants: remapComponentVariants(placed?.variants ?? styled.variants, ids),
      mask: styled.mask
        ? { ...styled.mask, sourceId: ids.get(styled.mask.sourceId) ?? styled.mask.sourceId }
        : undefined,
      componentProperties: remapComponentProperties(styled.componentProperties, ids),
      styleId: sameFile ? styled.styleId : undefined,
      styleOverrides: sameFile ? styled.styleOverrides : undefined,
      variant: detached ? undefined : node.variant,
      importKey: undefined,
      sourceKey: undefined,
      linkTo: link,
      interactions: remapInteractions(
        node.interactions,
        (id) => ids.get(id) ?? (sameFile && existing.has(id) ? id : undefined),
      ),
      instanceOf: hasMaster ? (ids.get(node.instanceOf!) ?? node.instanceOf) : undefined,
      componentSourceId: hasMaster
        ? (ids.get(node.componentSourceId ?? "") ?? node.componentSourceId)
        : undefined,
      instanceOverrides: hasMaster
        ? root
          ? [
              ...new Set([
                ...(node.instanceOverrides ?? []),
                "box.x",
                "box.y",
                "box.width",
                "box.height",
                "style.rotation",
                "style.flipX",
                "style.flipY",
                "positionMode",
                "widthMode",
                "heightMode",
                "horizontalConstraint",
                "verticalConstraint",
              ]),
            ]
          : node.instanceOverrides
        : undefined,
    };
  });
  return {
    document: parseDesignDocument({
      ...document,
      tokens: imported.tokens,
      designTokens: imported.designTokens,
      pages:
        libraryIds.size && !document.pages.some((p) => p.id === "library-components")
          ? [...document.pages, { id: "library-components", name: "Libraries" }]
          : document.pages,
      nodes: [...document.nodes, ...nodes],
    }),
    ids: roots.filter((node) => !node.librarySource).map((node) => ids.get(node.id)!),
  };
}

export function clipboardAssetIds(payload: DesignClipboard) {
  return [...new Set([...payload.nodes, ...(payload.resolvedNodes ?? [])].flatMap(nodeAssetIds))];
}

/** Remap every reference, including hidden fills and unselected component variants. */
export function remapClipboardAssets(
  payload: DesignClipboard,
  assets: Record<string, string>,
): DesignClipboard {
  const asset = (id: string | undefined) => {
    if (!id) return id;
    if (!assets[id]) throw new Error("A clipboard image could not be copied.");
    return assets[id];
  };
  const map = (node: DesignNode): DesignNode => {
    const styled = mapNodeStyles(node, (style) => ({
      ...style,
      ...(style.paints
        ? {
            paints: style.paints.map((paint) =>
              paint.type === "image" ? { ...paint, assetId: asset(paint.assetId) } : paint,
            ),
          }
        : {}),
    }));
    return {
      ...styled,
      assetId: asset(styled.assetId),
      ...(styled.variants
        ? {
            variants: {
              ...styled.variants,
              options: Object.fromEntries(
                Object.entries(styled.variants.options).map(([name, option]) => [
                  name,
                  {
                    ...option,
                    ...(option.root
                      ? {
                          root: {
                            ...option.root,
                            ...(option.root.assetId ? { assetId: asset(option.root.assetId) } : {}),
                          },
                        }
                      : {}),
                    ...(option.children
                      ? {
                          children: Object.fromEntries(
                            Object.entries(option.children).map(([id, changes]) => [
                              id,
                              {
                                ...changes,
                                ...(changes.assetId ? { assetId: asset(changes.assetId) } : {}),
                              },
                            ]),
                          ),
                        }
                      : {}),
                  },
                ]),
              ),
            },
          }
        : {}),
    };
  };
  return {
    ...payload,
    nodes: payload.nodes.map(map),
    ...(payload.resolvedNodes ? { resolvedNodes: payload.resolvedNodes.map(map) } : {}),
  };
}

export function pasteProperties(
  document: DesignDocument,
  payload: DesignClipboard,
  ids: string[],
): DesignDocument {
  const editable = ids.filter(
    (id) => document.nodes.some((node) => node.id === id) && !isLayerLocked(document.nodes, id),
  );
  if (!editable.length) return document;
  const imported = importTokens(document, payload);
  const source = payload.nodes[0];
  return editLayers(
    { ...document, tokens: imported.tokens, designTokens: imported.designTokens },
    editable,
    (node) => ({
      tokenBindings: {
        ...Object.fromEntries(
          (Object.keys(bindingKinds) as TokenBinding[])
            .filter(
              (key) =>
                !bindingPath(key).startsWith("box.") &&
                !["minWidth", "maxWidth", "minHeight", "maxHeight"].includes(key) &&
                (node.type !== "text"
                  ? key !== "textStyle"
                  : bindingPath(key).startsWith("style.") || key === "textStyle"),
            )
            .map((key) => [key, imported.node(source).tokenBindings?.[key] ?? null]),
        ),
      },
      style: {
        ...Object.fromEntries(Object.keys(node.style).map((key) => [key, undefined])),
        ...imported.style(source),
        rotation: node.style.rotation,
        flipX: node.style.flipX,
        flipY: node.style.flipY,
        imageCrop: source.assetId === node.assetId ? source.style.imageCrop : node.style.imageCrop,
      },
      ...(node.type === "text"
        ? {}
        : {
            layout: source.layout,
            gap: source.gap,
            padding: source.padding,
            paddingTop: source.paddingTop,
            paddingRight: source.paddingRight,
            paddingBottom: source.paddingBottom,
            paddingLeft: source.paddingLeft,
            align: source.align,
            justify: source.justify,
            wrap: source.wrap,
          }),
    }),
  );
}
