import { parseDesignDocument, type DesignDocument, type DesignNode } from "./document";
import { componentSubtreeIds, resolveVariantNodes } from "./component-variants";
import { instanceChildId, reconcileComponentStructure } from "./component-structure";
import { isLayerLocked } from "./edit-document";

function linkedRoot(document: DesignDocument, id: string) {
  const root = document.nodes.find((node) => node.id === id);
  if (
    !root?.instanceOf ||
    root.componentSourceId !== root.instanceOf ||
    isLayerLocked(document.nodes, id)
  )
    throw new Error("Select an unlocked component instance.");
  return root;
}

export function resetInstance(document: DesignDocument, id: string) {
  linkedRoot(document, id);
  const ids = componentSubtreeIds(document.nodes, id);
  const nodes = document.nodes.map((node) =>
    ids.has(node.id)
      ? {
          ...node,
          instanceOverrides: node.id === id ? ["box.x", "box.y"] : [],
          variant: node.id === id ? undefined : node.variant,
        }
      : node,
  );
  return parseDesignDocument({ ...document, nodes: reconcileComponentStructure(nodes, nodes) });
}

export function detachInstance(document: DesignDocument, id: string) {
  linkedRoot(document, id);
  const ids = componentSubtreeIds(document.nodes, id);
  const rendered = new Map(resolveVariantNodes(document.nodes).map((node) => [node.id, node]));
  return parseDesignDocument({
    ...document,
    nodes: document.nodes.map((node) =>
      ids.has(node.id)
        ? {
            ...rendered.get(node.id)!,
            instanceOf: undefined,
            componentSourceId: undefined,
            instanceOverrides: undefined,
            variants: undefined,
            variant: undefined,
          }
        : node,
    ),
  });
}

/** Unique relative source names/types transfer child overrides; ambiguous matches intentionally reset. */
function semanticPaths(nodes: readonly DesignNode[], rootId: string) {
  const ids = componentSubtreeIds(nodes, rootId),
    byId = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map<string, DesignNode | null>();
  for (const node of nodes)
    if (ids.has(node.id)) {
      const path: string[] = [];
      let current: DesignNode | undefined = node;
      while (current && current.id !== rootId) {
        const source = byId.get(current.componentSourceId ?? "") ?? current;
        path.unshift(JSON.stringify([source.type, source.name]));
        current = byId.get(current.parentId ?? "");
      }
      const key = path.join("/");
      result.set(key, result.has(key) ? null : node);
    }
  return result;
}

export function swapInstance(document: DesignDocument, id: string, masterId: string) {
  const root = linkedRoot(document, id);
  if (root.instanceOf === masterId) return document;
  const master = document.nodes.find((node) => node.id === masterId && node.isComponent);
  if (!master) throw new Error("Component not found.");
  const removed = componentSubtreeIds(document.nodes, id),
    sourceIds = componentSubtreeIds(document.nodes, masterId);
  if (sourceIds.has(id) || removed.has(masterId))
    throw new Error("A component cannot contain an instance of itself.");
  const prior = semanticPaths(document.nodes, id),
    next = semanticPaths(document.nodes, masterId);
  const matched = new Map(
    [...next].flatMap(([key, node]) =>
      node && prior.get(key) ? [[node.id, prior.get(key)!] as const] : [],
    ),
  );
  const ids = new Map(
    [...sourceIds].map((sourceId) => [
      sourceId,
      sourceId === masterId ? id : instanceChildId(id, sourceId),
    ]),
  );
  const copies = document.nodes
    .filter((node) => sourceIds.has(node.id))
    .map((source): DesignNode => {
      const previous = matched.get(source.id);
      const overrides = (previous?.instanceOverrides ?? []).filter(
        (path) =>
          ![
            "instanceOf",
            "componentSourceId",
            "parentId",
            "pageId",
            "id",
            "variant",
            "variants",
          ].includes(path.split(".")[0]) &&
          (source.type === previous?.type ||
            !["text", "assetId", "vectorPath"].includes(path.split(".")[0])),
      );
      const copy: DesignNode = {
        ...source,
        id: ids.get(source.id)!,
        parentId: source.id === masterId ? root.parentId : ids.get(source.parentId!)!,
        pageId: root.pageId,
        name: source.id === masterId ? root.name : source.name,
        isComponent: undefined,
        variants: undefined,
        variant:
          source.id === masterId
            ? root.variant && master.variants?.options[root.variant]
              ? root.variant
              : undefined
            : source.variant,
        instanceOf: masterId,
        componentSourceId: source.id,
        instanceOverrides: overrides,
        sourceKey: source.id === masterId ? root.sourceKey : undefined,
        importKey: source.id === masterId ? root.importKey : undefined,
      };
      if (previous)
        for (const path of overrides) {
          const keys = path.split(".");
          if (keys.some((key) => ["__proto__", "constructor", "prototype"].includes(key))) continue;
          let target = copy as unknown as Record<string, unknown>,
            value: unknown = previous;
          for (const key of keys)
            value =
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[key]
                : undefined;
          for (const key of keys.slice(0, -1)) {
            target[key] = { ...(target[key] as object) };
            target = target[key] as Record<string, unknown>;
          }
          if (value === undefined) delete target[keys.at(-1)!];
          else target[keys.at(-1)!] = value;
        }
      if (source.id === masterId) copy.box = { ...copy.box, x: root.box.x, y: root.box.y };
      return copy;
    });
  if (
    copies.some(
      (node) => !removed.has(node.id) && document.nodes.some((existing) => existing.id === node.id),
    )
  )
    throw new Error("Component child ID collision.");
  const position = document.nodes.findIndex((node) => node.id === id);
  const nodes = [
    ...document.nodes.slice(0, position).filter((node) => !removed.has(node.id)),
    ...copies,
    ...document.nodes.slice(position + 1).filter((node) => !removed.has(node.id)),
  ];
  return parseDesignDocument({
    ...document,
    nodes: reconcileComponentStructure(nodes, nodes),
    editedNodeIds: document.editedNodeIds.filter((nodeId) => !removed.has(nodeId) || nodeId === id),
  });
}
