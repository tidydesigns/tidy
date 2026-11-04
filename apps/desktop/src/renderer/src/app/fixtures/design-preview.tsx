import { useState } from "react";
import type { Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { CanvasArtwork } from "@tidy/editor/editor/canvas-artwork";
import {
  DocumentPreview,
  type PreviewBounds,
} from "@tidy/editor/components/files/document-preview";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
} from "@tidy/design/document";
import { childrenByParent } from "@tidy/design/node-hierarchy";
import { resolvedDocumentNodes, resolvedColorTokens } from "@tidy/design/design-tokens";

const noop = () => {};
const labels = [
  "Aleksandra Wiśniewska-Kowalczyk",
  "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
  "Jo",
  "Đặng Thị Ngọc Hân",
  "王秀英",
  "نور الهدى عبد الرحمن",
  "👩🏽‍💻 Priya",
  "<b>Design</b> &amp; **text**",
  "",
  "Line one\nLine two",
];
const datasets = ["Demo data", "Worst case", "Empty", "One", "1,000 rows"] as const;
type Dataset = (typeof datasets)[number];

function fixture(
  dataset: Dataset,
  width = 280,
  layout: DesignNode["layout"] = "flex-column",
): DesignDocument {
  const root = buildDrawnNode("board", "artboard", null, { x: 0, y: 0, width, height: 700 });
  root.layout = layout;
  if (layout === "grid") root.gridColumns = 2;
  if (dataset === "Worst case")
    root.responsiveBreakpoints = [
      {
        id: "ad949338-5997-4cb2-97b3-5e1694931843",
        frameMaxWidth: 320,
        gap: 4,
        padding: 16,
        ...(layout === "grid" ? { gridColumns: 1 } : {}),
      },
    ];
  root.padding = 12;
  root.gap = 8;
  root.style = { fill: "#171717", color: "#eeeeee", overflow: "visible" };
  const count =
    dataset === "Empty" ? 0 : dataset === "One" ? 1 : dataset === "1,000 rows" ? 1000 : 10;
  const nodes = Array.from({ length: count }, (_, index) => {
    const node = buildDrawnNode(`text-${index}`, "text", root.id, {
      x: 1400,
      y: 1800,
      width: 180,
      height: 28,
    });
    if (index === 3) node.visible = false;
    node.widthMode = "fill";
    node.heightMode = "hug";
    node.text = dataset === "Demo data" ? `Design ${index + 1}` : labels[index % labels.length];
    if (layout === "absolute") node.box = { ...node.box, x: 12, y: 12 + index * 60 };
    node.style = {
      fontSize: 14,
      fontWeight: index % 2 ? 400 : 600,
      ...(index === 2 ? { textAlign: "right" } : {}),
      ...(index === 4 ? { textAlign: "center" } : {}),
      ...(index === 5 ? { textWrap: "nowrap", textOverflow: "ellipsis" } : {}),
      ...(index === 6 ? { maxLines: 2 } : {}),
    };
    return node;
  });
  return parseDesignDocument({
    ...blankDesignDocument(),
    nodes: dataset === "Empty" ? [] : [root, ...nodes],
  });
}

function Comparison({
  content,
  width = 600,
  onBounds,
  previewScale = 1,
  previewOffset = { x: 0, y: 0 },
}: {
  content: DesignDocument;
  width?: number;
  previewScale?: number;
  previewOffset?: { x: number; y: number };
  onBounds?: (bounds: PreviewBounds) => void;
}) {
  const nodes = resolvedDocumentNodes(content);
  return (
    <div style={{ display: "flex", gap: 40 }}>
      <button
        className="thread-design-peek"
        data-preview
        style={{
          position: "relative",
          inset: "auto",
          width,
          height: 800,
          flexShrink: 0,
          animation: "none",
        }}
      >
        <DocumentPreview
          onBounds={onBounds}
          content={content}
          viewport={{ ...previewOffset, zoom: previewScale, width, height: 800 }}
        />
      </button>
      <div
        className="tidy-editor text-primary-black"
        data-canvas
        style={{ position: "relative", width, height: 800, flexShrink: 0 }}
      >
        <CanvasArtwork
          nodesById={new Map(nodes.map((node) => [node.id, node]))}
          childrenById={
            new Map<string | null, typeof nodes>([
              ...childrenByParent(nodes),
              [null, nodes.filter((node) => node.parentId === null)],
            ])
          }
          visibleRootIds={new Set(nodes.filter((node) => !node.parentId).map((node) => node.id))}
          tokens={resolvedColorTokens(content)}
          selectedIds={[]}
          prototypeMode={false}
          prototypeArtboardId={null}
          cropId={null}
          editingTextId={null}
          registerElement={noop}
          onMenu={noop}
          onDoubleClick={noop}
          onPointerDown={noop}
          onPointerMove={noop}
          onPointerUp={noop}
          onPointerCancel={noop}
          onTextDraft={noop}
          onTextFinish={noop}
        />
      </div>
    </div>
  );
}

export function DesignPreviewFixture() {
  const initial = new URLSearchParams(location.search).get("data");
  const [dataset, setDataset] = useState<Dataset>(
    datasets.find((value) => value === initial) ?? "Demo data",
  );
  return (
    <>
      <Comparison content={fixture(dataset)} />
      <div
        style={{
          position: "fixed",
          bottom: 12,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          background: "#dddddd",
          color: "#222222",
          padding: 4,
          gap: 4,
          borderRadius: 8,
        }}
      >
        {datasets.map((value) => (
          <button
            key={value}
            style={{
              padding: "4px 8px",
              background: value === dataset ? "white" : "transparent",
              borderRadius: 4,
            }}
            onClick={() => {
              const url = new URL(location.href);
              url.searchParams.set("data", value);
              history.replaceState(null, "", url);
              setDataset(value);
            }}
          >
            {value}
          </button>
        ))}
      </div>
    </>
  );
}

export async function runDesignPreviewTests(root: Root, host: HTMLElement) {
  const properties = [
    "color",
    "font-family",
    "font-size",
    "line-height",
    "text-align",
    "font-weight",
    "white-space",
    "width",
    "height",
    "display",
    "flex-direction",
    "letter-spacing",
    "text-transform",
    "text-decoration",
    "overflow",
    "background-color",
    "border-top-width",
    "border-radius",
    "opacity",
  ];
  let cases = 0;
  const scenarios: [Dataset, number, DesignNode["layout"], boolean][] = [
    ["Worst case", 280, "absolute", false],
    ["Worst case", 280, "flex-column", false],
    ["Worst case", 280, "flex-row", false],
    ["Worst case", 280, "grid", false],
    ["Worst case", 320, "grid", true],
    ["Worst case", 1280, "flex-column", true],
    ["Demo data", 320, "flex-column", false],
    ["Empty", 280, "flex-column", false],
    ["One", 280, "absolute", false],
    ["1,000 rows", 280, "flex-column", false],
  ];
  for (const [dataset, width, layout, rtlZoom] of scenarios) {
    const environment = rtlZoom
      ? { scheme: "dark", direction: "rtl", zoom: "2", scale: 0.375 }
      : { scheme: "light", direction: "ltr", zoom: "1", scale: 1 };
    host.style.colorScheme = environment.scheme;
    host.dir = environment.direction;
    host.style.zoom = environment.zoom;
    let crop: PreviewBounds | undefined;
    const content = fixture(dataset, width, layout);
    flushSync(() =>
      root.render(
        <Comparison
          width={width}
          previewScale={environment.scale}
          previewOffset={{ x: 17, y: 23 }}
          content={content}
          onBounds={(value) => {
            crop = value;
          }}
        />,
      ),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const previewSurface = host.querySelector<HTMLElement>("[data-preview]");
    const canvasSurface = host.querySelector<HTMLElement>("[data-canvas]");
    if (!previewSurface || !canvasSurface) throw new Error("Missing comparison surfaces");
    const previewBounds = previewSurface.getBoundingClientRect(),
      canvasBounds = canvasSurface.getBoundingClientRect();
    const zoom = Number(environment.zoom);
    for (const preview of host.querySelectorAll<HTMLElement>("[data-thumbnail-node]")) {
      const id = preview.dataset.thumbnailNode;
      const canvas = host.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
      if (!canvas) throw new Error(`Missing canvas layer ${id}`);
      const left = getComputedStyle(preview),
        right = getComputedStyle(canvas);
      for (const property of properties)
        if (left.getPropertyValue(property) !== right.getPropertyValue(property))
          throw new Error(
            `${dataset}/${width}/${environment.direction} ${id} ${property}: ${left.getPropertyValue(property)} != ${right.getPropertyValue(property)}`,
          );
      const a = preview.getBoundingClientRect(),
        b = canvas.getBoundingClientRect();
      for (const [name, actual, expected] of [
        [
          "x",
          (a.left - previewBounds.left - 17 * zoom) / environment.scale,
          b.left - canvasBounds.left,
        ],
        [
          "y",
          (a.top - previewBounds.top - 23 * zoom) / environment.scale,
          b.top - canvasBounds.top,
        ],
        ["width", a.width / environment.scale, b.width],
        ["height", a.height / environment.scale, b.height],
      ] as const) {
        if (Math.abs(actual - expected) > 0.1)
          throw new Error(
            `${dataset}/${width}/${environment.direction} ${id} ${name}: ${actual} != ${expected}`,
          );
      }
    }
    if (dataset === "Empty") {
      if (host.querySelector("[data-thumbnail-node], [data-node-id]") || crop)
        throw new Error("Empty document retained artwork or bounds");
    } else {
      if (!crop) throw new Error("Missing measured crop");
      const nodes = [...canvasSurface.querySelectorAll<HTMLElement>("[data-node-id]")];
      const bottom = Math.max(
        ...nodes.map((node) => (node.getBoundingClientRect().bottom - canvasBounds.top) / zoom),
      );
      const margin = Math.max(24, Math.min(width, bottom) * 0.08);
      if (
        Math.abs(crop.x + margin) > 0.1 ||
        Math.abs(crop.y + margin) > 0.1 ||
        Math.abs(crop.width - width - 2 * margin) > 0.1 ||
        Math.abs(crop.height - bottom - 2 * margin) > 0.1
      )
        throw new Error(
          `${dataset}/${width}: crop does not match rendered layout: ${JSON.stringify(crop)}`,
        );
    }
    cases++;
  }
  host.style.zoom = "";
  host.style.colorScheme = "";
  host.removeAttribute("dir");
  return `${cases} preview/canvas comparisons cover normal, worst, empty, single and 1,000-layer documents`;
}

export async function runPreviewBoundsTests(root: Root) {
  const original = fixture("1,000 rows");
  const clipped = parseDesignDocument({
    ...original,
    nodes: original.nodes.map((node) =>
      node.parentId === null ? { ...node, style: { ...node.style, overflow: "hidden" } } : node,
    ),
  });
  let crop: PreviewBounds | undefined;
  let reads = 0;
  const readBounds = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute("data-thumbnail-node")) reads++;
    return readBounds.call(this);
  };
  const settle = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  try {
    flushSync(() =>
      root.render(
        <Comparison
          content={clipped}
          onBounds={(value) => {
            crop = value;
          }}
        />,
      ),
    );
    await settle();
    if (!crop || Math.abs(crop.width - 328) > 0.1 || Math.abs(crop.height - 748) > 0.1)
      throw new Error("Clipped children changed the preview bounds");
    if (reads > 8)
      throw new Error(`Clipped preview measured ${reads} layers instead of its artboard`);
    reads = 0;
    flushSync(() =>
      root.render(
        <Comparison content={clipped} previewScale={0.5} previewOffset={{ x: 30, y: -40 }} />,
      ),
    );
    await settle();
    if (reads) throw new Error("Camera movement remeasured artwork");
  } finally {
    Element.prototype.getBoundingClientRect = readBounds;
  }
  const effectRoot = buildDrawnNode("paint-root", "container", null, {
    x: 100,
    y: 100,
    width: 100,
    height: 100,
  });
  const effectChild = buildDrawnNode("paint-child", "container", effectRoot.id, {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  const cases = [
    {
      name: "rotated shadow",
      nodes: [{ ...effectRoot, style: { rotation: 90, shadow: "400px 0px 0px 0px #000000" } }],
      expected: { x: 100, y: 100, width: 100, height: 500 },
    },
    {
      name: "nested reflected shadow",
      nodes: [
        { ...effectRoot, style: { rotation: 90 } },
        { ...effectChild, style: { flipX: true, shadow: "400px 0px 0px 0px #000000" } },
      ],
      expected: { x: 100, y: -300, width: 100, height: 500 },
    },
    {
      name: "diagonal outline",
      nodes: [{ ...effectRoot, style: { rotation: 45, outlineWidth: 40 } }],
      expected: {
        x: 150 - 90 * Math.SQRT2,
        y: 150 - 90 * Math.SQRT2,
        width: 180 * Math.SQRT2,
        height: 180 * Math.SQRT2,
      },
    },
    {
      name: "ancestor blur on overflowing child",
      nodes: [
        { ...effectRoot, style: { blur: 40 } },
        { ...effectChild, box: { ...effectChild.box, x: 400 } },
      ],
      expected: { x: -20, y: -20, width: 740, height: 340 },
    },
    {
      name: "hidden mask source",
      nodes: [
        { ...effectRoot, mask: { enabled: true, sourceId: effectChild.id, mode: "alpha" } },
        { ...effectChild, box: { ...effectChild.box, x: 1800 } },
      ],
      expected: { x: 100, y: 100, width: 100, height: 100 },
      maximumWidth: 148,
    },
    {
      name: "transparent subtree",
      nodes: [
        effectRoot,
        { ...effectChild, box: { ...effectChild.box, x: 1800 }, style: { opacity: 0 } },
      ],
      expected: { x: 100, y: 100, width: 100, height: 100 },
      maximumWidth: 148,
    },
  ];
  for (const test of cases) {
    const content = parseDesignDocument({ ...blankDesignDocument(), nodes: test.nodes });
    const result: { crop?: PreviewBounds } = {};
    flushSync(() =>
      root.render(
        <Comparison
          content={content}
          onBounds={(crop) => {
            result.crop = crop;
          }}
        />,
      ),
    );
    await settle();
    const actual = result.crop;
    const expected = test.expected;
    if (
      !actual ||
      actual.x > expected.x + 0.1 ||
      actual.y > expected.y + 0.1 ||
      actual.x + actual.width < expected.x + expected.width - 0.1 ||
      actual.y + actual.height < expected.y + expected.height - 0.1 ||
      (test.maximumWidth !== undefined && actual.width > test.maximumWidth + 0.1)
    )
      throw new Error(`Preview paint bounds failed for ${test.name}: ${JSON.stringify(actual)}`);
  }
}
