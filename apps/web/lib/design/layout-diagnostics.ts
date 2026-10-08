import type { DesignDocument, DesignNode } from "./document";
import { componentSubtreeIds, resolveVariantNodes } from "./component-variants";

export type LayoutIssue = {
  nodeId: string;
  code: string;
  severity: "error" | "warning";
  message: string;
  variant?: string;
};
const fixed = (mode: DesignNode["widthMode"]) => !mode || mode === "fixed";
const padding = (node: DesignNode, side: "Top" | "Right" | "Bottom" | "Left") =>
  node[`padding${side}`] ?? node.padding ?? 0;
const border = (node: DesignNode, side: "Top" | "Right" | "Bottom" | "Left") =>
  node.style[`border${side}Width`] ?? node.style.borderWidth ?? 0;

/** Checks only facts available in the document. Font measurement and visual comparison still need a browser. */
export function diagnoseLayout(document: DesignDocument): LayoutIssue[] {
  const current = diagnoseResolvedLayout({
    ...document,
    nodes: resolveVariantNodes(document.nodes),
  });
  const issues = [...current];
  for (const component of document.nodes.filter((node) => node.variants)) {
    const ids = componentSubtreeIds(document.nodes, component.id);
    for (const name of Object.keys(component.variants!.options)) {
      const resolved = resolveVariantNodes(document.nodes, new Map([[component.id, name]]));
      for (const issue of diagnoseResolvedLayout({ ...document, nodes: resolved }).filter((issue) =>
        ids.has(issue.nodeId),
      )) {
        if (
          !current.some(
            (existing) =>
              existing.nodeId === issue.nodeId &&
              existing.code === issue.code &&
              existing.message === issue.message,
          )
        )
          issues.push({ ...issue, variant: name, message: `Variant ${name}: ${issue.message}` });
      }
    }
  }
  return issues;
}

function diagnoseResolvedLayout(document: DesignDocument): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const children = new Map<string, DesignNode[]>();
  for (const node of document.nodes)
    if (node.parentId && node.visible)
      children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  function accessibleText(node: DesignNode): string {
    if (node.semantics?.hidden || !node.visible) return "";
    return (
      node.semantics?.label ??
      (node.type === "text"
        ? (node.text ?? "")
        : (children.get(node.id) ?? []).map(accessibleText).join(" "))
    );
  }
  const add = (
    node: DesignNode,
    code: string,
    severity: LayoutIssue["severity"],
    message: string,
  ) => issues.push({ nodeId: node.id, code, severity, message });
  for (const node of document.nodes) {
    if (node.minWidth !== undefined && node.maxWidth !== undefined && node.minWidth > node.maxWidth)
      add(node, "conflicting-width-limits", "error", "Minimum width exceeds maximum width.");
    if (
      node.minHeight !== undefined &&
      node.maxHeight !== undefined &&
      node.minHeight > node.maxHeight
    )
      add(node, "conflicting-height-limits", "error", "Minimum height exceeds maximum height.");
    const breakpoints = node.responsiveBreakpoints ?? [];
    if (
      new Set(breakpoints.map((rule) => rule.id)).size !== breakpoints.length ||
      new Set(breakpoints.map((rule) => rule.frameMaxWidth)).size !== breakpoints.length
    )
      add(
        node,
        "duplicate-breakpoint",
        "error",
        "Responsive breakpoint IDs and widths must be unique.",
      );
    if (!node.visible) continue;
    if (
      node.instanceOf &&
      (!byId.get(node.instanceOf)?.isComponent ||
        !node.componentSourceId ||
        !byId.has(node.componentSourceId))
    )
      add(
        node,
        "broken-component-source",
        "error",
        "This instance needs an existing component master and an existing componentSourceId. Preserve references when copying or reimporting nodes.",
      );
    const all = children.get(node.id) ?? [];
    const flow = all.filter((child) => child.positionMode !== "absolute");
    const interactive = ["button", "a"].includes(node.semantics?.element ?? "");
    if (!node.semantics && /(?:^|[\s_-])(button|btn)(?:$|[\s_-])/i.test(node.name))
      add(
        node,
        "missing-control-semantics",
        "warning",
        "This layer is named as a button. Supply semantics.element and construct its content with explicit flow alignment for native code export.",
      );
    if (interactive) {
      if (!accessibleText(node).trim())
        add(
          node,
          "missing-accessible-name",
          "error",
          "Give this control visible label text or semantics.label.",
        );
      if (node.semantics?.element === "a" && !node.semantics.href)
        add(
          node,
          "missing-link-target",
          "error",
          "Give this link an explicit semantics.href destination.",
        );
      if (
        (node.layout === "absolute" && all.some((child) => !child.semantics?.hidden)) ||
        all.some((child) => child.positionMode === "absolute" && !child.semantics?.hidden)
      )
        add(
          node,
          "absolute-control-content",
          "error",
          "Put the control's label and icon in a flex or grid content wrapper. Mark absolute decorative layers semantics.hidden.",
        );
      if (
        (node.layout.startsWith("flex") || node.layout === "grid") &&
        (node.align === undefined || node.justify === undefined)
      )
        add(
          node,
          "implicit-control-alignment",
          "error",
          "Set both align and justify explicitly on this control.",
        );
      for (const child of all) {
        let next = children.get(child.id) ?? [];
        while (next.length) {
          if (
            next.some((descendant) => ["button", "a"].includes(descendant.semantics?.element ?? ""))
          ) {
            add(
              node,
              "nested-control",
              "error",
              "Interactive controls cannot contain other interactive controls.",
            );
            break;
          }
          next = next.flatMap((descendant) => children.get(descendant.id) ?? []);
        }
        if (["button", "a"].includes(child.semantics?.element ?? ""))
          add(
            node,
            "nested-control",
            "error",
            "Interactive controls cannot contain other interactive controls.",
          );
      }
    }
    if (!node.layout.startsWith("flex") && node.layout !== "grid") continue;
    if (node.align === undefined || node.justify === undefined)
      add(
        node,
        "implicit-alignment",
        "warning",
        "Set align and justify to make alignment intentional and portable.",
      );
    for (const child of flow) {
      if (child.box.x !== 0 || child.box.y !== 0)
        add(
          child,
          "ignored-flow-coordinates",
          "warning",
          "Flow layout ignores box.x/y. Use parent padding, gap, align and justify; use explicit flow offsets only for intentional uneven spacing.",
        );
      if (node.widthMode === "hug" && child.widthMode === "fill")
        add(
          child,
          "cyclic-width-sizing",
          "error",
          "A fill-width child needs a parent with a resolved width; change the parent's hug width or the child's fill width.",
        );
      if (node.heightMode === "hug" && child.heightMode === "fill")
        add(
          child,
          "cyclic-height-sizing",
          "error",
          "A fill-height child needs a parent with a resolved height; change the parent's hug height or the child's fill height.",
        );
    }
    if (!node.layout.startsWith("flex") || !flow.length) continue;
    const row = node.layout === "flex-row",
      size = row ? "width" : "height",
      mode = row ? "widthMode" : "heightMode";
    const crossSize = row ? "height" : "width",
      crossMode = row ? "heightMode" : "widthMode";
    if (fixed(node[crossMode])) {
      const available =
        node.box[crossSize] -
        (row
          ? padding(node, "Top") +
            padding(node, "Bottom") +
            border(node, "Top") +
            border(node, "Bottom")
          : padding(node, "Left") +
            padding(node, "Right") +
            border(node, "Left") +
            border(node, "Right"));
      for (const child of flow) {
        const minimum = Math.max(
          fixed(child[crossMode]) ? child.box[crossSize] : 0,
          (row ? child.minHeight : child.minWidth) ?? 0,
        );
        if (minimum > available + 0.5)
          add(
            child,
            "cross-axis-overflow",
            !interactive && node.style.overflow ? "warning" : "error",
            `This child needs at least ${minimum}px of ${crossSize}, but ${node.name} has ${available}px after padding and borders.`,
          );
      }
    }
    if (node.wrap) continue;
    if (!fixed(node[mode])) continue;
    const available =
      node.box[size] -
      (row
        ? padding(node, "Left") +
          padding(node, "Right") +
          border(node, "Left") +
          border(node, "Right")
        : padding(node, "Top") +
          padding(node, "Bottom") +
          border(node, "Top") +
          border(node, "Bottom"));
    const gap = (row ? node.columnGap : node.rowGap) ?? node.gap ?? 0;
    const minimum =
      flow.reduce(
        (sum, child) =>
          sum +
          Math.max(
            fixed(child[mode]) ? child.box[size] : 0,
            (row ? child.minWidth : child.minHeight) ?? 0,
          ) +
          (child.flowGapBefore ?? 0),
        0,
      ) +
      gap * (flow.length - 1);
    if (minimum > available + 0.5)
      add(
        node,
        "flow-overflow",
        !interactive && node.style.overflow ? "warning" : "error",
        `Children need at least ${minimum}px along the ${size} axis, but the container has ${available}px after padding and borders. Resize, wrap, or change child sizing.`,
      );
  }
  return issues;
}

export function layoutReport(document: DesignDocument) {
  const issues = diagnoseLayout(document);
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
    visualVerification: "required" as const,
  };
}
