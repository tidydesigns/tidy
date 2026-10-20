import { replacePlainText, richTextPlain } from "./rich-text-runtime";
import type {
  ComponentVariants,
  DesignNode,
  DesignNodeChanges,
  VariantNodeChanges,
} from "./document";
import { detachChangedBindings, tokenBindingExclusions } from "./design-tokens";
import { childrenByParent } from "./node-hierarchy";

/** A copied nested component can also resolve its family through its source node. */
function findFamily(byId: ReadonlyMap<string, DesignNode>, node: DesignNode) {
  const seen = new Set<string>();
  let master: DesignNode | undefined = node;
  while (master && !seen.has(master.id)) {
    if (master.variants) return { master, variants: master.variants };
    seen.add(master.id);
    master = byId.get(master.componentSourceId ?? "");
  }
  return undefined;
}
/** Reuse family/source indexes while exporting many components of one snapshot. */
export function createComponentIndex(nodes: readonly DesignNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = childrenByParent(nodes);
  const subtrees = new Map<string, ReadonlySet<string>>();
  return {
    byId,
    subtreeIds(rootId: string) {
      let ids = subtrees.get(rootId);
      if (!ids) {
        ids = subtreeIds(children, rootId);
        subtrees.set(rootId, ids);
      }
      return ids;
    },
  };
}
type ComponentIndex = ReturnType<typeof createComponentIndex>;

export function componentFamily(
  nodes: readonly DesignNode[],
  node: DesignNode,
  index?: ComponentIndex,
) {
  if (node.variants) return { master: node, variants: node.variants };
  if (!node.componentSourceId) return undefined;
  return findFamily(index?.byId ?? new Map(nodes.map((item) => [item.id, item])), node);
}
function familySource(
  byId: ReadonlyMap<string, DesignNode>,
  ids: ReadonlySet<string>,
  node: DesignNode,
) {
  const seen = new Set<string>();
  let source: DesignNode | undefined = node;
  while (source && !seen.has(source.id)) {
    if (ids.has(source.id)) return source.id;
    seen.add(source.id);
    source = byId.get(source.componentSourceId ?? "");
  }
  return undefined;
}
function inheritedOverrides(byId: ReadonlyMap<string, DesignNode>, node: DesignNode) {
  const overrides = new Set(node.instanceOverrides ?? []);
  const seen = new Set([node.id]);
  let source = byId.get(node.componentSourceId ?? "");
  while (source && !seen.has(source.id)) {
    seen.add(source.id);
    for (const path of source.instanceOverrides ?? []) overrides.add(path);
    source = byId.get(source.componentSourceId ?? "");
  }
  return { ...node, instanceOverrides: [...overrides] };
}

function subtreeIds(children: ReadonlyMap<string, readonly DesignNode[]>, rootId: string) {
  const ids = new Set([rootId]);
  // Set iteration includes newly added IDs and also terminates for malformed cycles.
  for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child.id);
  return ids;
}

export function componentSubtreeIds(nodes: readonly DesignNode[], rootId: string) {
  return subtreeIds(childrenByParent(nodes), rootId);
}

/** Validate names and source references independently of layout or font measurements. */
export function validateComponentVariants(nodes: readonly DesignNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = childrenByParent(nodes);
  for (const node of nodes) {
    if (node.variants) {
      if (!node.isComponent)
        throw new Error(`Layer ${node.id}: variants belong to a component master.`);
      const descendants = subtreeIds(children, node.id);
      for (const [name, option] of Object.entries(node.variants.options)) {
        const changes = [[node.id, option.root], ...Object.entries(option.children ?? {})] as const;
        for (const [id, patch] of changes) {
          if (!patch) continue;
          if (!descendants.has(id) || (id === node.id && Object.hasOwn(option.children ?? {}, id)))
            throw new Error(
              `Variant ${name} on ${node.id}: child ${id} must belong to this component; use root for root overrides.`,
            );
          const target = byId.get(id)!;
          if (
            (target.vectorPath || target.vectorBoolean) &&
            (!patch.assetId || patch.assetId === target.assetId) &&
            patch.style?.paints?.some((paint) => paint.type === "image")
          )
            throw new Error(
              `Variant ${name}: path layers support solid and gradient fills (${id}).`,
            );
          if ((patch.text !== undefined || patch.richText !== undefined) && target.type !== "text")
            throw new Error(`Variant ${name}: text overrides need a text layer (${id}).`);
          if (patch.assetId !== undefined && !["image", "vector"].includes(target.type))
            throw new Error(
              `Variant ${name}: asset overrides need an image or vector layer (${id}).`,
            );
        }
      }
    }
    if (node.variant !== undefined) {
      const family = findFamily(byId, node);
      if (!family || !Object.hasOwn(family.variants.options, node.variant))
        throw new Error(
          `Layer ${node.id}: unknown variant ${node.variant}. Choose a named variant from its component master.`,
        );
    }
  }
}

const excluded = (paths: readonly string[], path: string) =>
  paths.some((entry) => path === entry || path.startsWith(`${entry}.`));

/** Shared edit/variant merge semantics: merge property groups and preserve explicit instance overrides. */
export function mergeNodeChanges(
  node: DesignNode,
  changes: DesignNodeChanges | VariantNodeChanges,
  exclusions: readonly string[] = [],
): DesignNode {
  exclusions = tokenBindingExclusions(exclusions);
  if (
    changes.richText &&
    changes.text !== undefined &&
    richTextPlain(changes.richText) !== changes.text
  )
    throw new Error("Rich text must match its plain text content.");
  const updated = { ...node };
  for (const [key, value] of Object.entries(changes)) {
    if (
      excluded(exclusions, key) ||
      (["text", "richText"].includes(key) &&
        exclusions.some((path) => path === "text" || path === "richText"))
    )
      continue;
    if (key === "style" || key === "box" || key === "tokenBindings") {
      const current = { ...updated[key] };
      for (const [property, next] of Object.entries(value ?? {}))
        if (!excluded(exclusions, `${key}.${property}`))
          Object.assign(current, { [property]: next });
      Object.assign(updated, { [key]: current });
    } else if (key === "states" && value) {
      const current = { ...updated.states };
      for (const [state, patch] of Object.entries(value)) {
        if (excluded(exclusions, `states.${state}`)) continue;
        const paints = { ...current[state as keyof typeof current] };
        for (const [property, next] of Object.entries(patch ?? {}))
          if (!excluded(exclusions, `states.${state}.${property}`))
            Object.assign(paints, { [property]: next });
        Object.assign(current, { [state]: paints });
      }
      updated.states = current;
    } else Object.assign(updated, { [key]: value });
  }
  if (
    changes.richText !== undefined &&
    !excluded(exclusions, "richText") &&
    !excluded(exclusions, "text")
  ) {
    updated.text = richTextPlain(changes.richText);
  } else if (
    changes.text !== undefined &&
    !excluded(exclusions, "text") &&
    !excluded(exclusions, "richText")
  ) {
    Object.assign(
      updated,
      replacePlainText({ text: node.text ?? "", richText: node.richText }, changes.text),
    );
  }
  if (
    changes.assetId !== undefined &&
    changes.assetId !== node.assetId &&
    !excluded(exclusions, "assetId")
  ) {
    if (changes.style?.imageCrop === undefined)
      updated.style = { ...updated.style, imageCrop: undefined, objectScale: 1 };
    updated.vectorPath = undefined;
  }
  if (node.tokenBindings || changes.tokenBindings)
    updated.tokenBindings = detachChangedBindings(updated, changes, exclusions);
  return updated;
}

export function changePaths(changes: DesignNodeChanges) {
  const paired =
    changes.text !== undefined || changes.richText !== undefined
      ? { ...changes, text: changes.text, richText: changes.richText }
      : changes;
  return Object.entries(paired).flatMap(([key, value]) =>
    key === "style" || key === "box" || key === "tokenBindings"
      ? Object.keys(value ?? {}).map((property) => `${key}.${property}`)
      : key === "states" && value
        ? Object.entries(value).flatMap(([state, patch]) =>
            Object.keys(patch ?? {}).map((property) => `states.${state}.${property}`),
          )
        : [key],
  );
}

function variantExclusions(node: DesignNode) {
  const paths = [...(node.instanceOverrides ?? [])];
  // Token bindings and paint stacks are alternative representations of the same colour.
  for (const group of [
    ["fill", "fillToken", "paints", "gradientFrom", "gradientTo", "gradientAngle"],
    ["color", "colorToken"],
    ["borderColor", "borderColorToken", "strokePaints"],
  ]) {
    const keys = group.map((key) => `style.${key}`);
    if (keys.some((key) => excluded(paths, key))) paths.push(...keys);
  }
  for (const state of ["hover", "pressed", "focus", "disabled"])
    for (const group of [
      ["fill", "fillToken"],
      ["color", "colorToken"],
      ["borderColor", "borderColorToken"],
    ]) {
      const keys = group.map((key) => `states.${state}.${key}`);
      if (keys.some((key) => excluded(paths, key))) paths.push(...keys);
    }
  return tokenBindingExclusions(paths);
}

function applyVariant(node: DesignNode, changes: VariantNodeChanges) {
  const skip = variantExclusions(node);
  let updated = mergeNodeChanges(node, changes, skip);
  if (updated.assetId !== node.assetId) updated.vectorPath = undefined;
  const paint = changes.style;
  if (
    paint &&
    (paint.fill !== undefined || paint.fillToken !== undefined) &&
    !excluded(skip, "style.fill") &&
    !excluded(skip, "style.fillToken")
  ) {
    updated = mergeNodeChanges(
      updated,
      {
        style: {
          paints: paint.paints,
          gradientFrom: paint.gradientFrom,
          gradientTo: paint.gradientTo,
          fillToken: paint.fillToken,
        },
      },
      skip,
    );
  }
  if (
    paint?.color !== undefined &&
    !excluded(skip, "style.color") &&
    !excluded(skip, "style.colorToken")
  )
    updated.style = { ...updated.style, colorToken: paint.colorToken };
  if (
    paint &&
    (paint.borderColor !== undefined || paint.borderColorToken !== undefined) &&
    !excluded(skip, "style.borderColor") &&
    !excluded(skip, "style.borderColorToken") &&
    !excluded(skip, "style.strokePaints")
  )
    updated.style = {
      ...updated.style,
      borderColorToken: paint.borderColorToken,
      strokePaints: paint.strokePaints,
    };
  return updated;
}

/** Resolve into a render view only. Persisted nodes always keep the shared base and selection. */
export function resolveVariantNodes(
  nodes: readonly DesignNode[],
  selections: ReadonlyMap<string, string> = new Map(),
  skipFamilies: ReadonlySet<string> = new Set(),
): DesignNode[] {
  if (!nodes.some((node) => node.variants)) return [...nodes];
  return createVariantResolver(nodes).resolve(selections, skipFamilies);
}

/** Request-local indexes for consumers inspecting many variants of one document.
 * Subtree resolution applies ancestor variants first, using the complete source
 * graph for copied component families, without rendering unrelated branches.
 */
export function createVariantResolver(nodes: readonly DesignNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const children = childrenByParent(nodes);
  const subtrees = new Map<string, DesignNode[]>();
  const sources = new Map<string, ReadonlySet<string>>();
  function subtree(rootId: string) {
    let result = subtrees.get(rootId);
    if (!result) {
      result = [...subtreeIds(children, rootId)]
        .flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
        .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      subtrees.set(rootId, result);
    }
    return result;
  }
  function render(
    selected: readonly DesignNode[],
    roots: readonly DesignNode[],
    ancestors: readonly DesignNode[],
    selections: ReadonlyMap<string, string>,
    skipFamilies: ReadonlySet<string>,
  ) {
    const rendered = new Map(selected.map((node) => [node.id, node]));
    function apply(node: DesignNode, descendants?: readonly DesignNode[]) {
      const family = findFamily(byId, node);
      if (!family || skipFamilies.has(node.id)) return;
      const name = selections.get(node.id) ?? node.variant ?? family.variants.default;
      if (!Object.hasOwn(family.variants.options, name))
        throw new Error(`Unknown variant ${name} on ${node.id}.`);
      const option = family.variants.options[name]!;
      if (option.root && rendered.has(node.id))
        rendered.set(
          node.id,
          applyVariant(inheritedOverrides(byId, rendered.get(node.id)!), option.root),
        );
      if (!option.children || !Object.keys(option.children).length) return;
      let sourceIds = sources.get(family.master.id);
      if (!sourceIds) {
        sourceIds = subtreeIds(children, family.master.id);
        sources.set(family.master.id, sourceIds);
      }
      for (const child of descendants ?? subtree(node.id)) {
        if (child.id === node.id) continue;
        const sourceId = familySource(byId, sourceIds, child);
        const patch = sourceId ? option.children[sourceId] : undefined;
        if (patch)
          rendered.set(
            child.id,
            applyVariant(inheritedOverrides(byId, rendered.get(child.id)!), patch),
          );
      }
    }
    for (const ancestor of ancestors) apply(ancestor, selected);
    function visit(node: DesignNode) {
      apply(node);
      for (const child of children.get(node.id) ?? []) visit(child);
    }
    for (const root of roots) visit(root);
    return selected.map((node) => {
      const result = rendered.get(node.id)!;
      return result === node ? node : { ...result, instanceOverrides: node.instanceOverrides };
    });
  }
  return {
    resolve(
      selections: ReadonlyMap<string, string> = new Map(),
      skipFamilies: ReadonlySet<string> = new Set(),
    ) {
      if (!nodes.some((node) => node.variants)) return [...nodes];
      return render(
        nodes,
        nodes.filter((node) => node.parentId === null),
        [],
        selections,
        skipFamilies,
      );
    },
    resolveSubtree(
      rootId: string,
      selections: ReadonlyMap<string, string> = new Map(),
      skipFamilies: ReadonlySet<string> = new Set(),
    ) {
      const root = byId.get(rootId);
      if (!root) throw new Error("Component root not found.");
      const ancestors: DesignNode[] = [];
      const seen = new Set([root.id]);
      let parent = byId.get(root.parentId ?? "");
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        ancestors.push(parent);
        parent = byId.get(parent.parentId ?? "");
      }
      return render(subtree(rootId), [root], ancestors.reverse(), selections, skipFamilies);
    },
  };
}

export function remapComponentVariants(
  variants: ComponentVariants | undefined,
  ids: ReadonlyMap<string, string>,
): ComponentVariants | undefined {
  if (!variants) return undefined;
  return {
    ...variants,
    options: Object.fromEntries(
      Object.entries(variants.options).map(([name, option]) => [
        name,
        {
          ...option,
          children: option.children
            ? Object.fromEntries(
                Object.entries(option.children).map(([id, changes]) => [
                  ids.get(id) ?? id,
                  changes,
                ]),
              )
            : undefined,
        },
      ]),
    ),
  };
}

/** Prepare a standalone family for an exported instance, retaining its explicit overrides. */
export function standaloneVariants(
  nodes: readonly DesignNode[],
  root: DesignNode,
  index?: ComponentIndex,
): ComponentVariants | undefined {
  const family = componentFamily(nodes, root, index);
  if (!family) return undefined;
  const graph = index ?? createComponentIndex(nodes);
  const ids = graph.subtreeIds(root.id);
  const byId = graph.byId;
  const sourceIds = graph.subtreeIds(family.master.id);
  const sourceToCopy = new Map(
    nodes
      .filter((node) => ids.has(node.id))
      .map((node) => [familySource(byId, sourceIds, node) ?? node.id, node]),
  );
  const keepChanges = (patch: VariantNodeChanges | undefined, node: DesignNode) => {
    if (!patch) return undefined;
    const exclusions = variantExclusions(inheritedOverrides(byId, node));
    const empty = {
      ...node,
      style: {},
      states: undefined,
      box: { x: 0, y: 0, width: 1, height: 1 },
    };
    const merged = mergeNodeChanges(empty, patch, exclusions);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (
        excluded(exclusions, key) ||
        (["text", "richText"].includes(key) &&
          exclusions.some((path) => path === "text" || path === "richText"))
      )
        continue;
      if (key === "style" || key === "box" || key === "tokenBindings")
        result[key] = Object.fromEntries(
          Object.entries(value ?? {}).filter(
            ([property]) => !excluded(exclusions, `${key}.${property}`),
          ),
        );
      else if (key === "states") result[key] = merged.states;
      else result[key] = value;
    }
    return result as VariantNodeChanges;
  };
  return {
    default: root.variant ?? family.variants.default,
    options: Object.fromEntries(
      Object.entries(family.variants.options).map(([name, option]) => [
        name,
        {
          root: keepChanges(option.root, root),
          children: Object.fromEntries(
            Object.entries(option.children ?? {}).flatMap(([sourceId, patch]) => {
              const copied = sourceToCopy.get(sourceId);
              return copied && copied.id !== root.id
                ? [[copied.id, keepChanges(patch, copied)!]]
                : [];
            }),
          ),
        },
      ]),
    ),
  };
}

/** Keep exposed bindings local when cloning or importing a component family. */
export function remapComponentProperties(
  properties: DesignNode["componentProperties"],
  ids: ReadonlyMap<string, string>,
) {
  return properties
    ? Object.fromEntries(
        Object.entries(properties).map(([key, property]) => [
          key,
          { ...property, targetId: ids.get(property.targetId) ?? property.targetId },
        ]),
      )
    : undefined;
}
