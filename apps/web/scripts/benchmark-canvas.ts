import { performanceDocument } from "../lib/design/examples/performance";
import { visibleCanvasRoots } from "@tidy/editor/design/canvas-culling";
import { resolvedDocumentNodes } from "@tidy/design/design-tokens";

const document = performanceDocument(5000);
document.designTokens = { radius: { type: "radius", value: 4 } };
for (const node of document.nodes) node.tokenBindings = { radius: "radius" };

function measure(name: string, run: () => unknown) {
  for (let i = 0; i < 20; i++) run();
  const samples = Array.from({ length: 7 }, () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return { name, iterations: 100, medianMs: samples[3], samplesMs: samples };
}

let edits = 0;
const results = [
  measure("cull-5000-layers", () =>
    visibleCanvasRoots(
      document.nodes,
      { x: 100, y: 100, zoom: 1 },
      { width: 1440, height: 1000 },
      [],
    ),
  ),
  measure("resolve-5000-bound-layers-after-one-edit", () =>
    resolvedDocumentNodes({
      ...document,
      nodes: document.nodes.map((node, index) =>
        index === 1 ? { ...node, name: `Edit ${edits++}` } : node,
      ),
    }),
  ),
];
process.stdout.write(`${JSON.stringify({ layers: document.nodes.length, results }, null, 2)}\n`);
