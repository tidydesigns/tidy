import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  type DesignNode,
} from "../document";

/** Nested layout, rotations, clipping, and a deliberately dense single-artboard case. */
export function buildHoverDocument(denseCount = 0) {
  const document = blankDesignDocument();
  const add = (
    id: string,
    type: Parameters<typeof buildDrawnNode>[1],
    parentId: string | null,
    box: DesignNode["box"],
    options: Partial<DesignNode> = {},
  ) => {
    const node = { ...buildDrawnNode(id, type, parentId, box), ...options };
    document.nodes.push(node);
    return node;
  };
  add(
    "hover-board",
    "artboard",
    null,
    { x: 80, y: 80, width: 560, height: 760 },
    {
      name: "Data / Dark",
      style: { fill: "#151719", overflow: "hidden" },
    },
  );
  if (denseCount) {
    for (let i = 0; i < denseCount; i++)
      add(
        `dense-${i}`,
        "container",
        "hover-board",
        {
          x: 12 + (i % 20) * 26,
          y: 12 + Math.floor(i / 20) * 26,
          width: 22,
          height: 22,
        },
        { name: `Dense layer ${i}`, style: { fill: i % 2 ? "#31483d" : "#3c4358", radius: 3 } },
      );
    return parseDesignDocument(document);
  }
  const text = (id: string, parent: string, value: string, box: DesignNode["box"], size = 14) =>
    add(id, "text", parent, box, {
      name: value,
      text: value,
      style: { fontFamily: "system-ui", fontSize: size, color: "#e4e7eb" },
    });
  add(
    "hover-header",
    "container",
    "hover-board",
    { x: 24, y: 24, width: 512, height: 60 },
    { name: "Header", style: {} },
  );
  text(
    "hover-title",
    "hover-header",
    "Layers, made clear",
    { x: 0, y: 0, width: 430, height: 28 },
    24,
  );
  text(
    "hover-subtitle",
    "hover-header",
    "Explore each section of the dashboard",
    { x: 0, y: 36, width: 430, height: 20 },
    12,
  );
  add(
    "hover-table",
    "container",
    "hover-board",
    { x: 24, y: 108, width: 512, height: 220 },
    {
      name: "Team table",
      layout: "flex-column",
      gap: 8,
      padding: 12,
      style: { fill: "#1c2024", radius: 10 },
    },
  );
  for (let i = 0; i < 4; i++) {
    add(
      `hover-row-${i}`,
      "container",
      "hover-table",
      { x: 0, y: 0, width: 488, height: 42 },
      {
        name: `Team row ${i + 1}`,
        layout: "flex-row",
        align: "center",
        gap: 20,
        style: { fill: "#23292e", radius: 5 },
      },
    );
    text(
      `hover-name-${i}`,
      `hover-row-${i}`,
      ["Alex Morgan", "Sam Taylor", "Jamie Chen", "Riley Park"][i],
      { x: 0, y: 0, width: 180, height: 24 },
    );
    text(
      `hover-status-${i}`,
      `hover-row-${i}`,
      "Active",
      { x: 0, y: 0, width: 90, height: 24 },
      12,
    );
  }
  add(
    "hover-card",
    "container",
    "hover-board",
    { x: 24, y: 356, width: 244, height: 150 },
    {
      name: "Votes card",
      style: { fill: "#23292e", radius: 10 },
    },
  );
  text("hover-card-label", "hover-card", "Votes today", { x: 16, y: 16, width: 200, height: 24 });
  text("hover-card-value", "hover-card", "24", { x: 16, y: 48, width: 190, height: 52 }, 42);
  text(
    "hover-card-detail",
    "hover-card",
    "12 members of the team voted",
    { x: 16, y: 116, width: 218, height: 20 },
    11,
  );
  add(
    "hover-clip",
    "container",
    "hover-board",
    { x: 300, y: 356, width: 220, height: 150 },
    {
      name: "Clipped artwork",
      style: { fill: "#23292e", overflow: "hidden", rotation: 8 },
    },
  );
  add(
    "hover-rotated",
    "container",
    "hover-clip",
    { x: -32, y: 40, width: 280, height: 80 },
    {
      name: "Rotated ribbon",
      style: { fill: "#cc8fa7", rotation: -22, flipX: true },
    },
  );
  add(
    "hover-palette",
    "container",
    "hover-board",
    { x: 24, y: 550, width: 512, height: 150 },
    {
      name: "Palette",
      style: {},
      layout: "grid",
      gridColumns: 4,
      gap: 12,
      padding: 12,
    },
  );
  for (const [i, color] of ["#d9d9d9", "#aab2bc", "#d9ad8f", "#e58a81"].entries())
    add(
      `hover-swatch-${i}`,
      "container",
      "hover-palette",
      { x: 0, y: 0, width: 104, height: 90 },
      {
        name: `Swatch ${i + 1}`,
        style: { fill: color, radius: 6 },
      },
    );
  add(
    "hover-locked",
    "container",
    "hover-board",
    { x: 24, y: 710, width: 200, height: 28 },
    {
      name: "Locked footer",
      locked: true,
      style: { fill: "#354237" },
    },
  );
  return parseDesignDocument(document);
}

/** A wide flex layout with a deeply clipped/rotated branch, not just flat DOM density. */
export function buildNestedHoverDocument() {
  const document = blankDesignDocument();
  const add = (
    id: string,
    parentId: string | null,
    box: DesignNode["box"],
    options: Partial<DesignNode> = {},
  ) => {
    const node = {
      ...buildDrawnNode(id, parentId ? "container" : "artboard", parentId, box),
      ...options,
    };
    document.nodes.push(node);
    return node;
  };
  add(
    "complex-board",
    null,
    { x: 40, y: 40, width: 1200, height: 860 },
    { name: "Hierarchy stress test", style: { fill: "#151719", overflow: "hidden" } },
  );
  add(
    "complex-layout",
    "complex-board",
    { x: 24, y: 24, width: 1152, height: 812 },
    { name: "Dashboard grid", layout: "grid", gridColumns: 4, gap: 16, padding: 16 },
  );
  for (let i = 0; i < 24; i++) {
    const card = add(
      `complex-card-${i}`,
      "complex-layout",
      { x: 0, y: 0, width: 264, height: 110 },
      {
        name: `Metric ${i + 1}`,
        layout: "flex-column",
        gap: 4,
        padding: 8,
        style: { fill: "#26333b", overflow: "hidden", radius: 8 },
      },
    );
    let parent = card;
    if (i === 0)
      for (let depth = 0; depth < 24; depth++) {
        parent = add(
          `complex-depth-${depth}`,
          parent.id,
          { x: 0, y: 0, width: 248 - depth * 4, height: 94 - depth * 2 },
          {
            name: `Clipped level ${depth + 1}`,
            padding: 1,
            style: { overflow: "hidden", rotation: depth % 2 ? -0.5 : 0.5 },
          },
        );
      }
    add(
      `complex-label-${i}`,
      parent.id,
      { x: 4, y: 4, width: i ? 230 : 140, height: 28 },
      {
        type: "text",
        text: `Metric ${i + 1}`,
        name: `Metric label ${i + 1}`,
        style: { fontFamily: "system-ui", fontSize: 14, color: "#e4e7eb" },
      },
    );
    if (i)
      add(
        `complex-value-${i}`,
        card.id,
        { x: 4, y: 38, width: 230, height: 36 },
        {
          type: "text",
          text: `${i * 127}`,
          name: `Metric value ${i + 1}`,
          style: { fontFamily: "system-ui", fontSize: 28, color: "#9ed4b0" },
        },
      );
  }
  return parseDesignDocument(document);
}
