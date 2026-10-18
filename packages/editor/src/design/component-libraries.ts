import {
  blankDesignDocument,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
} from "./document";
import { componentSubtreeIds } from "./component-variants";
import { reparentGeometry } from "./reparent-geometry";
import { copyLayers, readDesignClipboard, pasteLayers, type DesignClipboard } from "./clipboard";

export const LIBRARY_PAGE = "library-components";
export function libraryPayload(source: DesignDocument, componentId: string, fileUid: string) {
  const root = source.nodes.find((n) => n.id === componentId && n.isComponent && !n.librarySource);
  if (!root) throw new Error("Library component is missing or is itself linked.");
  const payload = readDesignClipboard(copyLayers(source, [componentId], fileUid));
  if (!payload) throw new Error("Library component could not be read.");
  return {
    ...payload,
    nodes: payload.nodes.map((n) => ({
      ...n,
      libraryNodeId: n.id,
      librarySource: undefined,
      styleId: undefined,
      styleOverrides: undefined,
    })),
  };
}
export function markLibraryStatus(
  document: DesignDocument,
  id: string,
  status: NonNullable<DesignNode["librarySource"]>["status"],
  revision?: number,
  expectedSource?: Pick<NonNullable<DesignNode["librarySource"]>, "fileUid" | "componentId">,
) {
  return parseDesignDocument({
    ...document,
    nodes: document.nodes.map((n) =>
      n.id === id &&
      n.librarySource &&
      (!expectedSource ||
        (n.librarySource.fileUid === expectedSource.fileUid &&
          n.librarySource.componentId === expectedSource.componentId))
        ? { ...n, librarySource: { ...n.librarySource, status, availableRevision: revision } }
        : n,
    ),
  });
}
function preserveOverrides(base: DesignNode, old: DesignNode) {
  const next = structuredClone(base) as unknown as Record<string, unknown>;
  for (const path of old.instanceOverrides ?? []) {
    if (
      [
        "instanceOf",
        "componentSourceId",
        "componentProperties",
        "variants",
        "variant",
        "librarySource",
        "libraryNodeId",
      ].includes(path.split(".")[0])
    )
      continue;
    const parts = path.split(".");
    let target = next,
      original = old as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      target[part] = { ...((target[part] as Record<string, unknown>) ?? {}) };
      target = target[part] as Record<string, unknown>;
      original = original?.[part] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (original?.[key] === undefined) delete target[key];
    else target[key] = structuredClone(original[key]);
  }
  return next as unknown as DesignNode;
}
/** Cache source geometry with stable local IDs, then update each instance without dropping overrides. */
export function importLibraryComponent(
  document: DesignDocument,
  payload: DesignClipboard,
  revision: number,
  createId: () => string,
  replaceId?: string,
) {
  const sourceRoot = payload.nodes.find((n) => n.parentId === null && n.isComponent);
  if (!sourceRoot || payload.nodes.filter((n) => n.parentId === null).length !== 1)
    throw new Error("Choose one library component.");
  const oldRoot = replaceId
    ? document.nodes.find((n) => n.id === replaceId && n.librarySource)
    : document.nodes.find(
        (n) =>
          n.librarySource?.fileUid === payload.sourceFile &&
          n.librarySource.componentId === sourceRoot.libraryNodeId,
      );
  if (replaceId && !oldRoot) throw new Error("Linked component not found.");
  if (
    oldRoot &&
    oldRoot.librarySource?.fileUid === payload.sourceFile &&
    oldRoot.librarySource.componentId === sourceRoot.libraryNodeId &&
    revision < oldRoot.librarySource.revision
  )
    throw new Error("Library revision is older than the cached source.");
  const oldIds = oldRoot ? componentSubtreeIds(document.nodes, oldRoot.id) : new Set<string>();
  const oldNodes = document.nodes.filter((n) => oldIds.has(n.id));
  const localIds = new Map(
    payload.nodes.map((n) => [
      n.id,
      n.id === sourceRoot.id && oldRoot
        ? oldRoot.id
        : (oldNodes.find((old) => old.libraryNodeId === n.libraryNodeId)?.id ?? createId()),
    ]),
  );
  const temporary = {
    ...blankDesignDocument(),
    pages: [{ id: LIBRARY_PAGE, name: "Libraries" }],
    tokens: document.tokens,
    designTokens: document.designTokens,
  };
  let index = 0;
  const imported = pasteLayers(temporary, payload, {
    fileId: "destination",
    pageId: LIBRARY_PAGE,
    parentId: null,
    inPlace: true,
    createId: () => localIds.get(payload.nodes[index++].id)!,
  });
  const rootId = imported.ids[0];
  const cache = imported.document.nodes.map((n) =>
    n.id === rootId
      ? {
          ...n,
          locked: true,
          box: oldRoot?.box ?? { ...n.box, x: 0, y: 0 },
          librarySource: {
            fileUid: payload.sourceFile,
            componentId: sourceRoot.libraryNodeId ?? sourceRoot.id,
            revision,
            status: "current" as const,
          },
        }
      : n,
  );
  let nodes = document.nodes.filter((n) => !oldIds.has(n.id));
  if (oldRoot) {
    const roots = nodes.filter(
      (n) => n.instanceOf === oldRoot.id && n.componentSourceId === oldRoot.id,
    );
    for (const root of roots) {
      const ids = componentSubtreeIds(nodes, root.id),
        old = nodes.filter((n) => ids.has(n.id));
      const replacements = new Map(
        cache.map((n) => [
          n.id,
          old.find((item) => item.componentSourceId === n.id)?.id ?? createId(),
        ]),
      );
      replacements.set(rootId, root.id);
      const rebuilt = cache.map((source) => {
        const previous = old.find((n) => n.componentSourceId === source.id);
        const base: DesignNode = {
          ...source,
          id: replacements.get(source.id)!,
          parentId: source.id === rootId ? root.parentId : replacements.get(source.parentId!)!,
          pageId: root.pageId,
          isComponent: undefined,
          componentProperties: undefined,
          variants: undefined,
          librarySource: undefined,
          locked: false,
          instanceOf: rootId,
          componentSourceId: source.id,
          instanceOverrides: previous?.instanceOverrides ?? [],
          mask: source.mask
            ? {
                ...source.mask,
                sourceId: replacements.get(source.mask.sourceId) ?? source.mask.sourceId,
              }
            : undefined,
          variant:
            source.id === rootId && root.variant && source.variants?.options[root.variant]
              ? root.variant
              : undefined,
        };
        const result = previous ? preserveOverrides(base, previous) : base;
        if (source.id === rootId) {
          result.name = root.name;
          result.box = { ...result.box, x: root.box.x, y: root.box.y };
        }
        return result;
      });
      const alive = new Set(rebuilt.map((n) => n.id));
      // Retain user-added layers and overridden removed source layers as ordinary local content.
      const retainedIds = new Set(
        old
          .filter((n) => !alive.has(n.id) && (!n.componentSourceId || n.instanceOverrides?.length))
          .map((n) => n.id),
      );
      for (const id of retainedIds)
        for (const child of old.filter((n) => n.parentId === id && !alive.has(n.id)))
          retainedIds.add(child.id);
      const retained = old
        .filter((n) => retainedIds.has(n.id))
        .map((n) => {
          const parentId =
            alive.has(n.parentId ?? "") || retainedIds.has(n.parentId ?? "") ? n.parentId : root.id;
          return {
            ...n,
            ...(parentId !== n.parentId ? reparentGeometry(document.nodes, n, parentId) : {}),
            parentId,
            instanceOf: undefined,
            componentSourceId: undefined,
            instanceOverrides: undefined,
            variant: undefined,
          };
        });
      const insertion = nodes
        .slice(
          0,
          nodes.findIndex((n) => n.id === root.id),
        )
        .filter((n) => !ids.has(n.id)).length;
      nodes = nodes.filter((n) => !ids.has(n.id));
      nodes.splice(insertion, 0, ...rebuilt, ...retained);
    }
  }
  const pages = document.pages.some((p) => p.id === LIBRARY_PAGE)
    ? document.pages
    : [...document.pages, { id: LIBRARY_PAGE, name: "Libraries" }];
  return {
    document: parseDesignDocument({
      ...document,
      pages,
      tokens: imported.document.tokens,
      designTokens: imported.document.designTokens,
      nodes: [...nodes, ...cache],
    }),
    rootId,
  };
}
