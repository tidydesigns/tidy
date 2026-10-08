import { textFontSegments } from "@bella/design/rich-text";
import {
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
  type VariantNodeChanges,
} from "../document";
import { closestFontStyle, fontFamilies, type FontFamily } from "./font-utils";
import { mergeNodeChanges } from "../component-variants";
type Style = DesignNode["style"];
export type FontReference = { nodeId: string; style: Style; text: string };
export type FontIdentity = { family: string; source?: Style["fontSource"] };
const fontFields = ["fontFamily", "fontSource", "fontFace", "fontWeight", "fontStyle"] as const;
export function fontIdentity(style: Style): FontIdentity {
  return {
    family: fontFamilies(style.fontFamily ?? "system-ui")[0] ?? "system-ui",
    source: style.fontSource,
  };
}
export function fontIdentityKey(identity: FontIdentity) {
  return `${identity.source ?? "auto"}:${identity.family.toLowerCase()}`;
}
const matches = (style: Style, identity: FontIdentity) =>
  fontIdentityKey(fontIdentity(style)) === fontIdentityKey(identity);
const overridesFont = (patch: VariantNodeChanges) =>
  fontFields.some((key) => patch.style?.[key] !== undefined);

/** Include all pages and inactive variants; a missing font may not be on the current canvas. */
export function documentFontReferences(document: DesignDocument): FontReference[] {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const instances = new Map<string, DesignNode[]>();
  for (const node of document.nodes)
    if (node.componentSourceId)
      instances.set(node.componentSourceId, [
        ...(instances.get(node.componentSourceId) ?? []),
        node,
      ]);
  const references = document.nodes
    .filter((node) => node.type === "text")
    .flatMap((node) =>
      textFontSegments({ ...node, text: node.text ?? "" }).map((segment) => ({
        nodeId: node.id,
        style: {
          ...node.style,
          fontWeight: segment.weight,
          fontStyle: segment.italic ? ("italic" as const) : ("normal" as const),
          fontFace: segment.face,
        },
        text: segment.text,
      })),
    );
  for (const owner of document.nodes)
    for (const option of Object.values(owner.variants?.options ?? {})) {
      for (const [id, patch] of [
        [owner.id, option.root],
        ...Object.entries(option.children ?? {}),
      ] as const) {
        const node = nodes.get(id);
        if (
          node?.type === "text" &&
          patch &&
          (overridesFont(patch) || patch.richText !== undefined || patch.text !== undefined)
        )
          for (const target of [node, ...(instances.get(id) ?? [])]) {
            const rendered = mergeNodeChanges(target, patch, target.instanceOverrides);
            for (const segment of textFontSegments({ ...rendered, text: rendered.text ?? "" }))
              references.push({
                nodeId: target.id,
                style: {
                  ...rendered.style,
                  fontWeight: segment.weight,
                  fontStyle: segment.italic ? "italic" : "normal",
                  fontFace: segment.face,
                },
                text: segment.text,
              });
          }
      }
    }
  return references;
}
function replacement(style: Style, target: FontFamily): Style {
  const face = closestFontStyle(target, style.fontWeight ?? 400, style.fontStyle === "italic");
  return {
    fontFamily: /[,"']/.test(target.family) ? JSON.stringify(target.family) : target.family,
    fontSource: target.source,
    fontFace: face.face,
    fontWeight: face.weight,
    fontStyle: face.italic ? "italic" : "normal",
  };
}
/** One document edit, including hidden/locked text and existing instance overrides. Undo restores it together. */
export function replaceDocumentFont(
  document: DesignDocument,
  source: FontIdentity,
  target: FontFamily,
): DesignDocument {
  if (!target.styles.length) throw new Error("Choose a font with an available style.");
  const originals = new Map(document.nodes.map((node) => [node.id, node]));
  const variant = (id: string, patch?: VariantNodeChanges): VariantNodeChanges | undefined => {
    const original = originals.get(id);
    if (!patch || original?.type !== "text" || !overridesFont(patch)) return patch;
    const effective = { ...original.style, ...patch.style };
    if (!matches(effective, source)) return patch;
    const font = replacement(effective, target);
    // Keep inherited family/source fields inherited when the base layer is replaced too.
    if (matches(original.style, source)) {
      if (patch.style?.fontFamily === undefined) delete font.fontFamily;
      if (patch.style?.fontSource === undefined) delete font.fontSource;
    }
    return { ...patch, style: { ...patch.style, ...font } };
  };
  return parseDesignDocument({
    ...document,
    nodes: document.nodes.map((node) => ({
      ...node,
      style:
        node.type === "text" && matches(node.style, source)
          ? { ...node.style, ...replacement(node.style, target) }
          : node.style,
      variants: node.variants
        ? {
            ...node.variants,
            options: Object.fromEntries(
              Object.entries(node.variants.options).map(([name, option]) => [
                name,
                {
                  ...option,
                  root: variant(node.id, option.root),
                  children: option.children
                    ? Object.fromEntries(
                        Object.entries(option.children).map(([id, patch]) => [
                          id,
                          variant(id, patch),
                        ]),
                      )
                    : undefined,
                },
              ]),
            ),
          }
        : undefined,
    })),
  });
}
