import { nodeId as rawId, type FigDocument, type FigNode } from "openfig-core";

export type FigmaInstanceLink = { master: string; source: string };
/** Resolve source component children before translating paints and layout. */
export function expandFigmaInstances(input: FigDocument, rootIds?: readonly string[]) {
  const nodes = [...input.nodes],
    nodeMap = new Map(input.nodeMap),
    childrenMap = new Map(input.childrenMap);
  const links = new Map<string, FigmaInstanceLink>(),
    unsupported = new Set<string>(),
    done = new Set<string>();
  const sessions = new Set(nodes.map((node) => node.guid.sessionID));
  let session = 0xffffffff,
    local = 0;
  while (sessions.has(session)) session--;
  const key = (node: FigNode) => rawId(node)!;
  const id = (guid: { sessionID: number; localID: number }) => `${guid.sessionID}:${guid.localID}`;
  const visiting = new Set<string>();
  function expand(original: FigNode, depth = 0) {
    const rootKey = key(original);
    if (done.has(rootKey) || original.type !== "INSTANCE") return;
    if (depth > 50 || visiting.has(rootKey))
      throw new Error("Figma components contain recursive instances.");
    const guid = original.symbolData?.symbolID;
    const master = guid ? nodeMap.get(id(guid)) : undefined;
    if (!master || master.type !== "SYMBOL") {
      unsupported.add(rootKey);
      done.add(rootKey);
      return;
    }
    visiting.add(rootKey);
    const masterKey = key(master);
    // Nested source instances must be expanded before copying their enclosing master.
    const base: FigNode[] = [];
    const seen = new Set<string>();
    function collect(parent: string) {
      if (seen.has(parent) || seen.size > 50_000)
        throw new Error("Figma component hierarchy is cyclic or too large.");
      seen.add(parent);
      for (const child of childrenMap.get(parent) ?? []) {
        if (child.type === "INSTANCE") expand(child, depth + 1);
        const current = nodeMap.get(key(child))!;
        base.push(current);
        collect(key(current));
      }
    }
    collect(masterKey);
    // Existing expanded payloads retain their actual children; preserve them as snapshots.
    if ((childrenMap.get(rootKey) ?? []).length) {
      unsupported.add(rootKey);
      done.add(rootKey);
      visiting.delete(rootKey);
      return;
    }
    const overrides = new Map<string, Record<string, unknown>>();
    for (const value of original.symbolData?.symbolOverrides ?? []) {
      const path = value.guidPath?.guids;
      if (!Array.isArray(path) || path.length !== 1) {
        unsupported.add(rootKey);
        continue;
      }
      const { guidPath: _path, ...changes } = value as Record<string, unknown>;
      void _path;
      overrides.set(id(path[0]), changes);
    }
    if (original.symbolData?.uniformScaleFactor && original.symbolData.uniformScaleFactor !== 1)
      unsupported.add(rootKey);
    const root: FigNode = {
      ...master,
      ...original,
      ...overrides.get(masterKey),
      guid: original.guid,
      parentIndex: original.parentIndex,
      type: "INSTANCE",
      name: original.name,
    };
    nodeMap.set(rootKey, root);
    nodes[nodes.findIndex((node) => key(node) === rootKey)] = root;
    links.set(rootKey, { master: masterKey, source: masterKey });
    const guids = new Map(
      base.map((node) => [key(node), { sessionID: session, localID: ++local }]),
    );
    const copies: FigNode[] = [];
    for (const source of base) {
      if (nodes.length >= 50_000)
        throw new Error("Expanded Figma components exceed the import's record limit.");
      const copy: FigNode = {
        ...source,
        ...overrides.get(key(source)),
        guid: guids.get(key(source))!,
        parentIndex: {
          ...source.parentIndex!,
          guid:
            source.parentIndex && id(source.parentIndex.guid) === masterKey
              ? original.guid
              : guids.get(id(source.parentIndex!.guid))!,
        },
      };
      const copyKey = key(copy);
      nodes.push(copy);
      nodeMap.set(copyKey, copy);
      copies.push(copy);
      links.set(copyKey, { master: masterKey, source: key(source) });
    }
    const groups = new Map<string, FigNode[]>();
    for (const copy of copies) {
      const parent = id(copy.parentIndex!.guid);
      const children = groups.get(parent) ?? [];
      children.push(copy);
      groups.set(parent, children);
    }
    for (const [parent, children] of groups) childrenMap.set(parent, children);
    done.add(rootKey);
    visiting.delete(rootKey);
  }
  if (rootIds) {
    const walked = new Set<string>();
    function walk(root: string, depth = 0) {
      if (depth > 100) throw new Error("Figma layer hierarchy is too deeply nested.");
      if (walked.has(root)) return;
      walked.add(root);
      // Copies are already expanded from their source. Only walk original
      // records here, so nested copies are not expanded a second time.
      if (!input.nodeMap.has(root)) return;
      const node = nodeMap.get(root)!;
      const children = childrenMap.get(root) ?? [];
      if (node.type === "INSTANCE") expand(node);
      for (const child of children) walk(key(child), depth + 1);
    }
    for (const root of rootIds) walk(root);
  } else {
    for (const node of input.nodes) if (node.type === "INSTANCE") expand(node);
  }
  return { document: { ...input, nodes, nodeMap, childrenMap }, links, unsupported };
}
