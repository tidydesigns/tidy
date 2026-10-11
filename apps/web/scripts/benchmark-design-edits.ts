import {
  blankDesignDocument,
  designNodeSchema,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
} from "../../../packages/design/document";
import { changedLayers, trackDocumentChanges } from "../lib/design/edit-document";
import * as editing from "../lib/design/edit-document";
import { reconcileComponentStructure } from "../lib/design/component-structure";
import { cpus } from "node:os";

const results: { name: string; size: number; samples: number; p50Ms: number; p95Ms: number }[] = [];
const samples = Number(process.env.MCP_KERNEL_SAMPLES ?? 20);
function measure(name: string, size: number, work: () => unknown) {
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
  for (const [name, work] of Object.entries(edits)) measure(name, size, work);
  if (edits.completeEdit().nodes.some((node) => node.style.fill !== "#112233"))
    throw new Error("Component propagation lost an edit");
  if (process.env.MCP_KERNEL_BATCH === "1") {
    const independent: DesignDocument = {
      ...document,
      nodes: nodes.map((node) => ({
        ...node,
        instanceOf: undefined,
        componentSourceId: undefined,
        isComponent: undefined,
      })),
    };
    for (const count of [20, 250].filter((count) => count <= size)) {
      const requests = independent.nodes.slice(0, count).map((node) => ({
        nodeId: node.id,
        changes: { name: `Edited ${node.id}` },
      }));
      const prepare = () =>
        editing.changedLayerBatch
          ? editing.changedLayerBatch(independent, requests)
          : requests.reduce<DesignNode[]>(
              (nodes, edit) =>
                changedLayers({ ...independent, nodes }, [edit.nodeId], edit.changes),
              independent.nodes,
            );
      measure(`prepare ${count} independent edits`, size, prepare);
      measure(`validate ${count} independent edits`, size, () =>
        trackDocumentChanges(independent, { ...independent, nodes: prepare() }),
      );
      if (
        prepare()
          .slice(0, count)
          .some((node) => node.name !== `Edited ${node.id}`)
      )
        throw new Error("Batch lost an edit");
    }
  }
}
const report = { runtime: `Bun ${Bun.version}`, cpu: cpus()[0].model, results };
if (process.env.MCP_BENCHMARK_OUTPUT)
  await Bun.write(process.env.MCP_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
