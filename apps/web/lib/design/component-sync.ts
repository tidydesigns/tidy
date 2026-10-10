import type { DesignNodeChanges } from "@/lib/design/document";
import type { DesignNode, DesignDocument } from "./document";
import { materializeChangedBindings, tokenBindingExclusions } from "./design-tokens";
import { applyResizeConstraints, innerSize } from "./constraints";
import { changePaths, mergeNodeChanges } from "./component-variants";
import { remapInteractions } from "@bella/design/prototype";

type Changes = DesignNodeChanges;

/** Apply an edit to a master and all non-overridden instance properties. */
export function syncComponentEdit(
  nodes: DesignNode[],
  nodeId: string,
  changes: Changes,
  document?: Pick<DesignDocument, "tokens" | "designTokens">,
): DesignNode[] {
  const session = componentEditSession(nodes, document);
  session.edit(nodeId, changes);
  return session.finish();
}

/** Transaction-local indexes. Property patches cannot change node IDs, parents,
 * or component links. Never mutate the input snapshot or retain this session
 * across document revisions. Resize constraints still settle after each edit. */
export function componentEditSession(
  nodes: DesignNode[],
  document?: Pick<DesignDocument, "tokens" | "designTokens">,
) {
  const next = new Map(nodes.map((node) => [node.id, node]));
  // Index once: propagation visits affected copies instead of rescanning every
  // layer for every source in the queue (O(n + affected), excluding patch size).
  const copiesBySource = new Map<string, DesignNode[]>();
  for (const node of nodes) {
    if (!node.componentSourceId || !node.instanceOf) continue;
    const copies = copiesBySource.get(node.componentSourceId);
    if (copies) copies.push(node);
    else copiesBySource.set(node.componentSourceId, [node]);
  }
  // Interaction/mask remaps previously rebuilt an ancestry map for every
  // candidate lookup. Relationships cannot change in a property patch, so one
  // lazy per-operation index safely serves all copied references.
  let references: Map<string | undefined, Map<string, string>> | undefined;
  const roots = new Map<string, string | undefined>();
  const referenceInInstance = (sourceId: string, copyId: string) => {
    const rootOf = (id: string) => {
      const path = new Set<string>();
      let current = next.get(id),
        root: string | undefined;
      while (current && !path.has(current.id)) {
        if (roots.has(current.id)) {
          root = roots.get(current.id);
          break;
        }
        path.add(current.id);
        if (current.instanceOf && current.componentSourceId === current.instanceOf) {
          root = current.id;
          break;
        }
        current = next.get(current.parentId ?? "");
      }
      for (const member of path) roots.set(member, root);
      return root;
    };
    if (!references) {
      references = new Map();
      for (const node of nodes) {
        if (!node.componentSourceId) continue;
        const root = rootOf(node.id);
        const family = references.get(root) ?? new Map<string, string>();
        if (!family.has(node.componentSourceId)) family.set(node.componentSourceId, node.id);
        references.set(root, family);
      }
    }
    return references.get(rootOf(copyId))?.get(sourceId) ?? sourceId;
  };
  const edit = (nodeId: string, changes: Changes) => {
    const touched = new Map<string, DesignNode>();
    const set = (id: string, node: DesignNode) => {
      if (!touched.has(id)) touched.set(id, next.get(id)!);
      next.set(id, node);
    };
    const source = next.get(nodeId);
    if (!source) throw new Error("Node not found.");
    const changedPaths = changePaths(changes);
    const updated = mergeNodeChanges(
      document ? materializeChangedBindings(source, changes, document) : source,
      changes,
    );
    if (source.styleId && changes.style)
      updated.styleOverrides = [
        ...new Set([...(source.styleOverrides ?? []), ...Object.keys(changes.style)]),
      ];
    set(
      nodeId,
      source.instanceOf
        ? {
            ...updated,
            instanceOverrides: [...new Set([...(source.instanceOverrides ?? []), ...changedPaths])],
          }
        : updated,
    );
    const queue = [{ id: nodeId, changes }];
    const visited = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const edit = queue[index];
      if (visited.has(edit.id)) throw new Error("Recursive component source references.");
      visited.add(edit.id);
      for (const node of copiesBySource.get(edit.id) ?? []) {
        const current = next.get(node.id)!;
        const exclusions = tokenBindingExclusions([
          ...(current.instanceOverrides ?? []),
          ...(current.instanceOf === current.componentSourceId
            ? [
                "box.x",
                "box.y",
                "variants",
                "variant",
                "componentProperties",
                "librarySource",
                "libraryNodeId",
              ]
            : []),
        ]);
        const scopedChanges = Object.hasOwn(edit.changes, "interactions")
          ? {
              ...edit.changes,
              interactions: remapInteractions(edit.changes.interactions, (id) =>
                referenceInInstance(id, node.id),
              ),
            }
          : edit.changes;
        const inheritedChanges = scopedChanges.mask
          ? {
              ...scopedChanges,
              mask: {
                ...scopedChanges.mask,
                sourceId: referenceInInstance(edit.changes.mask!.sourceId, node.id),
              },
            }
          : scopedChanges;
        const inherited = mergeNodeChanges(
          document
            ? materializeChangedBindings(current, inheritedChanges, document, exclusions)
            : current,
          inheritedChanges,
          exclusions,
        );
        set(node.id, inherited);
        const propagated: Changes = {};
        for (const path of changePaths(edit.changes)) {
          if (exclusions.some((skip) => path === skip || path.startsWith(`${skip}.`))) continue;
          const [key, child] = path.split(".");
          if (child && (key === "style" || key === "box" || key === "tokenBindings"))
            Object.assign(propagated, {
              [key]: { ...propagated[key], [child]: inherited[key]?.[child as never] },
            });
          else if (key === "states") Object.assign(propagated, { states: inherited.states });
          else Object.assign(propagated, { [key]: inherited[key as keyof DesignNode] });
        }
        if (Object.keys(propagated).length) queue.push({ id: node.id, changes: propagated });
      }
    }
    // Only a size/border change can affect descendant constraints. Ordinary
    // property batches visit changed nodes, not all N nodes after every edit.
    if (
      [...touched].some(([id, old]) => {
        const from = innerSize(old),
          to = innerSize(next.get(id)!);
        return from.width !== to.width || from.height !== to.height;
      })
    ) {
      const after = [...next.values()];
      const before = after.map((node) => touched.get(node.id) ?? node);
      for (const node of applyResizeConstraints(before, after)) next.set(node.id, node);
    }
  };
  return {
    get: (id: string) => next.get(id),
    edit,
    finish: () => [...next.values()],
  };
}
