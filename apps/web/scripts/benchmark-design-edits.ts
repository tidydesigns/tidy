import {
  blankDesignDocument,
  designNodeSchema,
  parseDesignDocument,
} from "../../../packages/design/document";
import { changedLayers, trackDocumentChanges } from "../lib/design/edit-document";
import { reconcileComponentStructure } from "../lib/design/component-structure";
import { cpus } from "node:os";

const results = [];
const samples = Number(process.env.MCP_KERNEL_SAMPLES ?? 20);
for (const size of [100, 500, 1500, 5000]) {
  const master = designNodeSchema.parse({
    id: "master",
    type: "container",
    name: "Button",
    parentId: null,
    isComponent: true,
    box: { x: 0, y: 0, width: 100, height: 32 },
  });
  const nodes = [
    master,
    ...Array.from({ length: size - 1 }, (_, i) => ({
      ...master,
      id: `instance-${i}`,
      isComponent: undefined,
      instanceOf: "master",
      componentSourceId: "master",
      instanceOverrides: [],
    })),
  ];
  const document = parseDesignDocument({ ...blankDesignDocument(), nodes });
  const changed = changedLayers(document, ["master"], { style: { fill: "#112233" } });
  const edits = {
    validation: () => parseDesignDocument(document),
    propagation: () => changedLayers(document, ["master"], { style: { fill: "#112233" } }),
    reconciliation: () => reconcileComponentStructure(document.nodes, changed),
    completeEdit: () =>
      trackDocumentChanges(document, {
        ...document,
        nodes: changedLayers(document, ["master"], { style: { fill: "#112233" } }),
      }),
  };
  for (const [name, work] of Object.entries(edits)) {
    for (let i = 0; i < 5; i++) work();
    const latencies = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      work();
      latencies.push(performance.now() - start);
    }
    latencies.sort((a, b) => a - b);
    results.push({
      name,
      size,
      samples,
      p50Ms: +latencies[Math.ceil(samples * 0.5) - 1].toFixed(3),
      p95Ms: +latencies[Math.ceil(samples * 0.95) - 1].toFixed(3),
    });
  }
  if (edits.completeEdit().nodes.some((node) => node.style.fill !== "#112233"))
    throw new Error("Component propagation lost an edit");
}
const report = { runtime: `Bun ${Bun.version}`, cpu: cpus()[0].model, results };
if (process.env.MCP_BENCHMARK_OUTPUT)
  await Bun.write(process.env.MCP_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
