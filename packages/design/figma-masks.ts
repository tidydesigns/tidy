import { nodeId, type FigDocument, type FigNode } from "openfig-core";
import type { DesignNode } from "./document";
import { imageMaskPaint, vectorMaskSource } from "./vector-relationships";
import { FIGMA_LIMITS } from "./figma-input";

/** Figma masks affect subsequent siblings. Tidy models that scope with a group.
 * Reparent without changing coordinates, stopping at the next mask. */
export function importFigmaMasks(
  document: FigDocument,
  nodes: DesignNode[],
  ids: Map<string, string>,
  warn: (node: FigNode, message: string) => void,
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const siblings of document.childrenMap.values()) {
    for (let index = 0; index < siblings.length; index++) {
      const raw = siblings[index];
      if (!raw.isMask && !raw.mask) continue;
      const source = byId.get(ids.get(nodeId(raw)!)!);
      if (!source) continue;
      const parent = source.parentId ? byId.get(source.parentId) : undefined;
      const image = imageMaskPaint(source, nodes);
      const mode = raw.maskType ?? raw.maskMode ?? "ALPHA";
      if (
        (parent && parent.layout !== "absolute") ||
        !["ALPHA", "LUMINANCE"].includes(mode) ||
        (!image && !vectorMaskSource(source, nodes))
      ) {
        warn(raw, "This mask source or mode cannot be represented; inspect the masked layers.");
        continue;
      }
      const members = [source];
      for (let next = index + 1; next < siblings.length; next++) {
        if (siblings[next].isMask || siblings[next].mask) break;
        const member = byId.get(ids.get(nodeId(siblings[next])!)!);
        if (member) members.push(member);
      }
      if (nodes.length >= FIGMA_LIMITS.nodes)
        throw new Error("Mask groups exceed this import's editable layer limit.");
      const group: DesignNode = {
        id: crypto.randomUUID(),
        parentId: source.parentId,
        pageId: source.pageId,
        type: "container",
        name: `${source.name} mask`.slice(0, 120),
        // Image masks need their own surface as the CSS sizing reference. Vector
        // masks may extend beyond it, which the existing SVG viewport preserves.
        box: image
          ? { ...source.box }
          : {
              x: 0,
              y: 0,
              width: parent?.box.width ?? source.box.width,
              height: parent?.box.height ?? source.box.height,
            },
        layout: "absolute",
        widthMode: "fixed",
        heightMode: "fixed",
        positionMode: "absolute",
        style: { overflow: "visible" },
        visible: true,
        locked: false,
        mask: {
          sourceId: source.id,
          mode: mode === "LUMINANCE" ? "luminance" : "alpha",
          enabled: true,
        },
      };
      nodes.splice(nodes.indexOf(source), 0, group);
      byId.set(group.id, group);
      for (const member of members) {
        member.parentId = group.id;
        member.box = {
          ...member.box,
          x: member.box.x - group.box.x,
          y: member.box.y - group.box.y,
        };
        member.positionMode = "absolute";
      }
      // Source surface dimensions are measured, even if Figma used a childless
      // Auto Layout frame for the image.
      source.widthMode = source.heightMode = "fixed";
    }
  }
}
