import { DESIGN_DOCUMENT_LIMITS } from "@tidy/design/document-limits";
import { remapInteractions } from "@tidy/design/prototype";
import type { DesignNode } from "./document";
import { resolveVariantNodes } from "./component-variants";
import { equalJsonValues as equal } from "./json-value";
import { ComponentStructureError } from "./component-structure-error";

const identity = new Set([
  "id",
  "parentId",
  "pageId",
  "isComponent",
  "instanceOf",
  "componentSourceId",
  "instanceOverrides",
  "importKey",
  "sourceKey",
  "sourcePath",
  "variants",
  "variant",
  "componentProperties",
  "librarySource",
  "libraryNodeId",
]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function paths(before: unknown, after: unknown, prefix = ""): string[] {
  if (equal(before, after)) return [];
  if (object(before) && object(after))
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      paths(before[key], after[key], prefix ? `${prefix}.${key}` : key),
    );
  return [prefix];
}
function valueAt(value: unknown, path: string) {
  for (const key of path.split(".")) value = object(value) ? value[key] : undefined;
  return value;
}
function retain(target: DesignNode, original: DesignNode, path: string) {
  const keys = path.split(".");
  if (keys.some((key) => ["__proto__", "constructor", "prototype"].includes(key))) return;
  let result = target as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    result[key] = object(result[key]) ? { ...result[key] } : {};
    result = result[key] as Record<string, unknown>;
  }
  const value = valueAt(original, path);
  if (value === undefined) delete result[keys.at(-1)!];
  else result[keys.at(-1)!] = value;
}

/** Stable on every client/server; reject collisions instead of adopting another layer. */
export function instanceChildId(root: string, source: string) {
  const input = JSON.stringify([root, source]);
  const words = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let i = 0; i < input.length; i++)
    for (let j = 0; j < words.length; j++)
      words[j] = Math.imul(words[j] ^ (input.charCodeAt(i) + j * 131), 16777619);
  return `ci-${words.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("")}`;
}

/** Linked structure belongs to the master; property overrides belong to the instance. */
export function reconcileComponentStructure(
  before: readonly DesignNode[],
  input: readonly DesignNode[],
): DesignNode[] {
  if (!before.some((node) => node.instanceOf) && !input.some((node) => node.instanceOf))
    return [...input];
  // Each immutable array gets one parent/order index. Property-only edits keep
  // that array throughout refresh; structural replacements rebuild as needed.
  const indexes = new WeakMap<
    readonly DesignNode[],
    {
      children: Map<string, DesignNode[]>;
      positions: Map<string, number>;
    }
  >();
  const index = (list: readonly DesignNode[]) => {
    let value = indexes.get(list);
    if (!value) {
      const children = new Map<string, DesignNode[]>();
      const positions = new Map<string, number>();
      list.forEach((node, position) => {
        positions.set(node.id, position);
        if (node.parentId) {
          const siblings = children.get(node.parentId);
          if (siblings) siblings.push(node);
          else children.set(node.parentId, [node]);
        }
      });
      value = { children, positions };
      indexes.set(list, value);
    }
    return value;
  };
  const subtreeIds = (list: readonly DesignNode[], root: string) => {
    const children = index(list).children;
    const ids = new Set([root]);
    for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child.id);
    return ids;
  };
  const subtreeNodes = (
    list: readonly DesignNode[],
    ids: ReadonlySet<string>,
    lookup: ReadonlyMap<string, DesignNode>,
  ) => {
    const positions = index(list).positions;
    return [...ids]
      .filter((id) => lookup.has(id))
      .sort((a, b) => positions.get(a)! - positions.get(b)!)
      .map((id) => lookup.get(id)!);
  };
  const order = (list: readonly DesignNode[], parent: string) =>
    (index(list).children.get(parent) ?? []).map((node) => node.componentSourceId ?? node.id);
  const old = new Map(before.map((node) => [node.id, node]));
  let nodes = [...input];
  let byId = new Map(nodes.map((node) => [node.id, node]));
  // Existing deletion helpers detach a deleted source. A child deletion instead removes its copies.
  const removed = new Set(
    before
      .filter(
        (node) =>
          node.componentSourceId &&
          !byId.has(node.componentSourceId) &&
          node.instanceOf &&
          byId.has(node.instanceOf) &&
          (!byId.get(node.instanceOf)?.librarySource ||
            byId.get(node.id)?.instanceOf === node.instanceOf),
      )
      .map((node) => node.id),
  );
  for (const id of removed) for (const child of subtreeIds(nodes, id)) removed.add(child);
  nodes = nodes.filter((node) => !removed.has(node.id));
  byId = new Map(nodes.map((node) => [node.id, node]));
  const renderedBefore = new Map(resolveVariantNodes(before).map((node) => [node.id, node]));
  nodes = nodes.map((node) => {
    const previous = old.get(node.id);
    if (
      (previous?.instanceOf && !node.instanceOf) ||
      (node.instanceOf && !byId.get(node.instanceOf)?.isComponent)
    ) {
      return {
        ...(renderedBefore.get(node.id) ?? node),
        id: node.id,
        parentId: node.parentId,
        pageId: node.pageId,
        instanceOf: undefined,
        componentSourceId: undefined,
        instanceOverrides: undefined,
        variant: undefined,
      };
    }
    const source = byId.get(node.componentSourceId ?? "");
    if (!previous || previous.componentSourceId !== node.componentSourceId || !source) return node;
    // Raw editor/import operations also record property overrides, while inherited changes do not.
    const comparableMask =
      node.mask && byId.get(node.mask.sourceId)?.parentId === node.id
        ? {
            ...node,
            mask: {
              ...node.mask,
              sourceId: byId.get(node.mask.sourceId)?.componentSourceId ?? node.mask.sourceId,
            },
          }
        : node;
    const comparable = {
      ...comparableMask,
      interactions: remapInteractions(
        node.interactions,
        (id) => byId.get(id)?.componentSourceId ?? id,
      ),
    };
    const changed = paths(previous, node).filter(
      (path) =>
        !identity.has(path.split(".")[0]) &&
        !equal(valueAt(comparable, path), valueAt(source, path)),
    );
    return changed.length
      ? {
          ...node,
          instanceOverrides: [...new Set([...(node.instanceOverrides ?? []), ...changed])],
        }
      : node;
  });
  byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>(),
    complete = new Set<string>();
  function refresh(rootId: string) {
    if (complete.has(rootId)) return;
    if (visiting.has(rootId)) throw new Error("Components cannot contain recursive instances.");
    const root = byId.get(rootId);
    if (!root?.instanceOf || root.componentSourceId !== root.instanceOf) return;
    const master = byId.get(root.instanceOf);
    if (!master?.isComponent) return;
    visiting.add(rootId);
    let sources = subtreeIds(nodes, master.id);
    if (sources.has(rootId)) throw new Error("A component cannot contain an instance of itself.");
    for (const id of sources) {
      const child = byId.get(id)!;
      if (child.instanceOf && child.instanceOf === child.componentSourceId) refresh(id);
    }
    sources = subtreeIds(nodes, master.id);
    const subtree = subtreeIds(nodes, rootId);
    const copies = new Map<string, DesignNode>();
    for (const node of subtreeNodes(nodes, subtree, byId))
      if (node.instanceOf === master.id && node.componentSourceId) {
        if (copies.has(node.componentSourceId))
          throw new Error(
            "Duplicate linked component child. Detach before changing instance structure.",
          );
        copies.set(node.componentSourceId, node);
      }
    const ids = new Map(
      [...sources].map((id) => [
        id,
        id === master.id ? rootId : (copies.get(id)?.id ?? instanceChildId(rootId, id)),
      ]),
    );
    const sourceNodes = subtreeNodes(nodes, sources, byId);
    const newNodes = sourceNodes.map((source) => {
      const existing = copies.get(source.id);
      const id = ids.get(source.id)!;
      if (!existing && byId.has(id)) throw new Error("Component child ID collision.");
      const copy: DesignNode = {
        ...source,
        id,
        parentId: source.id === master.id ? root.parentId : ids.get(source.parentId!)!,
        pageId: root.pageId,
        name: source.id === master.id ? root.name : source.name,
        isComponent: undefined,
        variants: undefined,
        componentProperties: undefined,
        librarySource: undefined,
        libraryNodeId: existing?.libraryNodeId ?? source.libraryNodeId,
        locked: master.librarySource ? (existing?.locked ?? false) : source.locked,
        variant: source.id === master.id ? root.variant : source.variant,
        instanceOf: master.id,
        componentSourceId: source.id,
        instanceOverrides: existing ? existing.instanceOverrides : [],
        importKey: existing?.importKey,
        sourceKey: existing?.sourceKey,
        mask: source.mask
          ? { ...source.mask, sourceId: ids.get(source.mask.sourceId) ?? source.mask.sourceId }
          : undefined,
        interactions: remapInteractions(source.interactions, (id) => ids.get(id) ?? id),
        linkTo: source.linkTo ? (ids.get(source.linkTo) ?? source.linkTo) : undefined,
      };
      if (existing)
        for (const path of existing.instanceOverrides ?? [])
          if (!identity.has(path.split(".")[0])) retain(copy, existing, path);
      if (source.id === master.id) copy.box = { ...copy.box, x: root.box.x, y: root.box.y };
      return existing && equal(existing, copy) ? existing : copy;
    });
    const local = master.librarySource
      ? subtreeNodes(nodes, subtree, byId).filter(
          (node) => node.id !== rootId && node.instanceOf !== master.id,
        )
      : [];
    const localIds = new Set(local.map((node) => node.id));
    // Instance-local structural changes are explicit detach operations, never silently discarded.
    for (const id of subtree)
      if (id !== rootId) {
        const child = byId.get(id)!;
        if (!localIds.has(id) && (!child.componentSourceId || child.instanceOf !== master.id))
          throw new ComponentStructureError(
            "Detach the instance before adding or reparenting its children.",
            rootId,
            master.id,
          );
      }
    const previousRoot = old.get(rootId);
    if (previousRoot?.instanceOf === master.id) {
      const priorIds = subtreeIds(before, rootId);
      const priorCopies = new Map(
        subtreeNodes(before, priorIds, old)
          .filter((node) => node.instanceOf === master.id && node.componentSourceId)
          .map((node) => [node.componentSourceId!, node]),
      );
      for (const source of sourceNodes) {
        if (source.id === master.id) continue;
        const existing = copies.get(source.id);
        const priorCopy = priorCopies.get(source.id);
        const priorSource = old.get(source.id);
        if (priorCopy && !existing && priorSource?.parentId === source.parentId)
          throw new ComponentStructureError(
            "Detach the instance before deleting or moving its children.",
            rootId,
            master.id,
          );
        if (
          existing &&
          existing.parentId !== ids.get(source.parentId!) &&
          priorSource?.parentId === source.parentId
        )
          throw new ComponentStructureError(
            "Detach the instance before reparenting its children.",
            rootId,
            master.id,
          );
      }
      for (const source of sourceNodes) {
        const parent = ids.get(source.id)!;
        const priorOrder = order(before, parent),
          nextOrder = order(nodes, parent);
        const nextIds = new Set(nextOrder);
        const common = priorOrder.filter((id) => nextIds.has(id));
        const commonIds = new Set(common);
        if (
          !equal(
            common,
            nextOrder.filter((id) => commonIds.has(id)),
          ) &&
          equal(order(before, source.id), order(nodes, source.id))
        )
          throw new ComponentStructureError(
            "Detach the instance before reordering its children.",
            rootId,
            master.id,
          );
      }
    }
    // Keep the instance root's place in its siblings and emit children in source order.
    const position = index(nodes).positions.get(rootId)!;
    const rootCopy = newNodes.find((node) => node.id === rootId)!;
    const replacement = [rootCopy, ...newNodes.filter((node) => node.id !== rootId), ...local];
    // Preserve exact canonical order. Avoid an O(n) array copy and map rebuild
    // when refresh produced the same contiguous subtree by identity.
    if (
      subtree.size === replacement.length &&
      replacement.every((node, i) => nodes[position + i] === node)
    ) {
      visiting.delete(rootId);
      complete.add(rootId);
      return;
    }
    const first = nodes.slice(0, position).filter((node) => !subtree.has(node.id));
    const rest = nodes.slice(position + 1).filter((node) => !subtree.has(node.id));
    nodes = [...first, ...replacement, ...rest];
    if (nodes.length > DESIGN_DOCUMENT_LIMITS.nodes)
      throw new Error(
        `Component update exceeds the ${DESIGN_DOCUMENT_LIMITS.nodes.toLocaleString()}-layer limit.`,
      );
    byId = new Map(nodes.map((node) => [node.id, node]));
    visiting.delete(rootId);
    complete.add(rootId);
  }
  for (const node of nodes)
    if (node.instanceOf === node.componentSourceId && node.instanceOf) refresh(node.id);
  return nodes;
}
