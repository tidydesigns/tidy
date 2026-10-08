import { reconcileComponentStructure } from "./component-structure";
import { nodePageId, parseDesignDocument, type DesignDocument } from "@/lib/design/document";
import { documentPages } from "@/lib/design/pages";
import { reconcileImportNotes } from "./import-notes";
import { remapComponentProperties, remapComponentVariants } from "./component-variants";
import { importTokenDefinitions } from "./tokens";
import { remapInteractions } from "@bella/design/prototype";

export function mergeImport(
  current: DesignDocument | null,
  incoming: DesignDocument,
  importId: string,
  resolution?: "keep_user" | "use_import" | "duplicate",
) {
  const parseMerged = (next: DesignDocument) =>
    parseDesignDocument({
      ...next,
      nodes: reconcileComponentStructure(current?.nodes ?? [], next.nodes),
    });
  const key = incoming.source
    ? `${incoming.source.project}:${incoming.source.route}`
    : incoming.nodes[0]?.importKey;
  if (!current)
    return parseMerged({ ...incoming, warnings: reconcileImportNotes(null, incoming, key) });
  const definitions = importTokenDefinitions(current, incoming);
  incoming = {
    ...incoming,
    tokens: definitions.tokens,
    designTokens: definitions.designTokens,
    nodes: incoming.nodes.map(definitions.node),
  };
  if (!key) throw new Error("Updating a file requires source project and route metadata.");
  const prior = current.nodes.filter((node) => node.importKey === key);
  const targetPageId = prior.length ? nodePageId(prior[0]) : documentPages(current)[0].id;
  incoming = {
    ...incoming,
    nodes: incoming.nodes.map((node) => ({ ...node, pageId: targetPageId })),
  };
  const retained = current.nodes.filter((node) => node.importKey !== key);
  const conflicts = prior.filter((node) => current.editedNodeIds.includes(node.id));
  const tombstones = current.deletedSourceKeys ?? [];
  const deletedKeys = new Set(
    tombstones.filter((item) => item.importKey === key).map((item) => item.sourceKey),
  );
  const deletedConflicts = incoming.nodes.filter(
    (node) => node.sourceKey && deletedKeys.has(node.sourceKey),
  );
  if ((conflicts.length || deletedConflicts.length) && !resolution)
    throw new Error(
      `Manually edited or deleted nodes need a resolution: ${[
        ...conflicts.map((node) => node.id),
        ...deletedConflicts.map((node) => node.sourceKey),
      ].join(", ")}`,
    );
  if (resolution === "duplicate") {
    const ids = new Map(incoming.nodes.map((node) => [node.id, `${importId}-${node.id}`]));
    const right = Math.max(
      0,
      ...current.nodes
        .filter((node) => node.parentId === null && nodePageId(node) === targetPageId)
        .map((node) => node.box.x + node.box.width),
    );
    const roots = incoming.nodes.filter((node) => node.parentId === null);
    const left = roots.length ? Math.min(...roots.map((node) => node.box.x)) : 0;
    const copy = incoming.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      parentId: node.parentId ? ids.get(node.parentId)! : null,
      instanceOf: node.instanceOf ? (ids.get(node.instanceOf) ?? node.instanceOf) : undefined,
      componentSourceId: node.componentSourceId
        ? (ids.get(node.componentSourceId) ?? node.componentSourceId)
        : undefined,
      linkTo: node.linkTo ? (ids.get(node.linkTo) ?? node.linkTo) : undefined,
      interactions: remapInteractions(node.interactions, (id) => ids.get(id) ?? id),
      variants: remapComponentVariants(node.variants, ids),
      componentProperties: remapComponentProperties(node.componentProperties, ids),
      styleId: undefined,
      styleOverrides: undefined,
      importKey: `${key}#${importId}`,
      box: node.parentId === null ? { ...node.box, x: node.box.x + right - left + 120 } : node.box,
    }));
    return parseMerged({
      ...current,
      tokens: { ...current.tokens, ...incoming.tokens },
      designTokens: incoming.designTokens,
      nodes: [...current.nodes, ...copy],
      warnings: reconcileImportNotes(current, incoming, `${key}#${importId}`, ids, true),
    });
  }

  const priorBySource = new Map(
    prior.filter((node) => node.sourceKey).map((node) => [node.sourceKey, node]),
  );
  // Source keys represent the same layer across reruns, even when the importer regenerates IDs.
  const stableIds = new Map(
    incoming.nodes.map((node) => [
      node.id,
      node.sourceKey ? (priorBySource.get(node.sourceKey)?.id ?? node.id) : node.id,
    ]),
  );
  const imported = incoming.nodes
    .filter(
      (node) => resolution !== "keep_user" || !node.sourceKey || !deletedKeys.has(node.sourceKey),
    )
    .map((node) => {
      const old = node.sourceKey ? priorBySource.get(node.sourceKey) : undefined;
      const stable = {
        ...node,
        id: stableIds.get(node.id)!,
        parentId: node.parentId ? stableIds.get(node.parentId)! : null,
        instanceOf: node.instanceOf
          ? (stableIds.get(node.instanceOf) ?? node.instanceOf)
          : undefined,
        componentSourceId: node.componentSourceId
          ? (stableIds.get(node.componentSourceId) ?? node.componentSourceId)
          : undefined,
        linkTo: node.linkTo ? (stableIds.get(node.linkTo) ?? node.linkTo) : undefined,
        interactions: remapInteractions(node.interactions, (id) => stableIds.get(id) ?? id),
        variants: remapComponentVariants(node.variants, stableIds),
        componentProperties: remapComponentProperties(node.componentProperties, stableIds),
        styleId: undefined,
        styleOverrides: undefined,
      };
      return resolution === "keep_user" && old && current.editedNodeIds.includes(old.id)
        ? {
            ...old,
            parentId: stable.parentId,
            importKey: stable.importKey,
            sourceKey: stable.sourceKey,
            sourcePath: stable.sourcePath,
          }
        : stable;
    });
  const importedIds = new Set(imported.map((node) => node.id));
  const retainedIds = new Set(retained.map((node) => node.id));
  const dangling = retained.find(
    (node) => node.parentId && !retainedIds.has(node.parentId) && !importedIds.has(node.parentId),
  );
  if (dangling)
    throw new Error(
      `Reimport would detach user layer ${dangling.id}. Keep its source parent or move the layer first.`,
    );
  return parseMerged({
    ...current,
    source: incoming.source,
    tokens: { ...current.tokens, ...incoming.tokens },
    designTokens: incoming.designTokens,
    nodes: [...retained, ...imported],
    warnings: reconcileImportNotes(current, incoming, key, stableIds),
    deletedSourceKeys:
      resolution === "use_import"
        ? tombstones.filter((item) => item.importKey !== key)
        : tombstones,
    editedNodeIds: current.editedNodeIds.filter(
      (id) => retainedIds.has(id) || (resolution === "keep_user" && importedIds.has(id)),
    ),
  });
}
