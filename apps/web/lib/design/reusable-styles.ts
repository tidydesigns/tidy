import { parseDesignDocument, type DesignDocument, type DesignNode } from "./document";
import { resolveNodeTokens } from "./design-tokens";
import { syncComponentEdit } from "./component-sync";
import { isLayerLocked } from "./edit-document";

export function createReusableStyle(
  document: DesignDocument,
  nodeId: string,
  id: string,
  name: string,
) {
  const node = document.nodes.find((n) => n.id === nodeId);
  if (!node || isLayerLocked(document.nodes, nodeId) || document.reusableStyles?.[id])
    throw new Error("Choose an unlocked layer and a new style identity.");
  return applyReusableStyle(
    parseDesignDocument({
      ...document,
      reusableStyles: {
        ...document.reusableStyles,
        [id]: { name, style: resolveNodeTokens(node, document).style },
      },
    }),
    [nodeId],
    id,
  );
}
export function applyReusableStyle(document: DesignDocument, ids: string[], id: string) {
  const source = document.reusableStyles?.[id];
  if (!source) throw new Error("Reusable style is unavailable.");
  let nodes = document.nodes;
  for (const node of nodes.filter((n) => ids.includes(n.id) && !isLayerLocked(nodes, n.id))) {
    const oldKeys = Object.keys(document.reusableStyles?.[node.styleId ?? ""]?.style ?? {});
    const style = { ...node.style };
    for (const key of oldKeys) Object.assign(style, { [key]: undefined });
    nodes = syncComponentEdit(
      nodes,
      node.id,
      { style: { ...style, ...source.style } },
      document,
    ).map((n) => (n.id === node.id ? { ...n, styleId: id, styleOverrides: [] } : n));
  }
  return parseDesignDocument({ ...document, nodes });
}
export function updateReusableStyle(
  document: DesignDocument,
  id: string,
  style: DesignNode["style"],
) {
  const old = document.reusableStyles?.[id];
  if (!old) throw new Error("Reusable style is unavailable.");
  let nodes = document.nodes;
  for (const node of document.nodes.filter((n) => n.styleId === id)) {
    const patch = Object.fromEntries(
      [...new Set([...Object.keys(old.style), ...Object.keys(style)])]
        .filter((key) => !node.styleOverrides?.includes(key))
        .map((key) => [key, style[key as keyof typeof style]]),
    );
    nodes = syncComponentEdit(nodes, node.id, { style: patch }, document).map((n) =>
      n.id === node.id
        ? { ...n, styleOverrides: node.styleOverrides, instanceOverrides: node.instanceOverrides }
        : n,
    );
  }
  return parseDesignDocument({
    ...document,
    reusableStyles: { ...document.reusableStyles, [id]: { ...old, style } },
    nodes,
  });
}
export function detachReusableStyle(document: DesignDocument, ids: string[]) {
  return parseDesignDocument({
    ...document,
    nodes: document.nodes.map((n) =>
      ids.includes(n.id) ? { ...n, styleId: undefined, styleOverrides: undefined } : n,
    ),
  });
}
export function removeReusableStyle(document: DesignDocument, id: string) {
  const styles = { ...document.reusableStyles };
  delete styles[id];
  return parseDesignDocument({
    ...detachReusableStyle(
      document,
      document.nodes.filter((n) => n.styleId === id).map((n) => n.id),
    ),
    reusableStyles: styles,
  });
}
