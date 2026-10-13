import { cpus } from "node:os";
import { resolve } from "node:path";
import type { DesignDocument } from "../../../packages/design/document";
import { percentile, writeBenchmarkReport } from "./editor-benchmark";

// One harness runs against either checkout. Only in-memory synthetic documents are used.
const root = resolve(process.env.EDITOR_BENCH_ROOT ?? process.cwd());
const schema = await import(`${root}/packages/design/document.ts`);
const editing = await import(`${root}/apps/web/lib/design/edit-document.ts`);
const patches = await import(`${root}/apps/web/lib/design/document-patch.ts`);
const fixtures = await import(`${root}/apps/web/lib/design/examples/performance.ts`);
const controlOnly = process.env.EDITOR_BENCH_CONTROL_ONLY === "1";
const parser: (input: unknown) => DesignDocument = controlOnly
  ? schema.parseDesignDocument
  : (schema.parseImmutableDesignDocument ?? schema.parseDesignDocument);
const samples = Number(process.env.EDITOR_BENCH_SAMPLES ?? 80);
if (!Number.isInteger(samples) || samples < 20) throw new Error("Use at least 20 samples.");
const results: { scenario: string; nodes: number; p50Ms: number; p95Ms: number }[] = [];
function measure(scenario: string, nodes: number, work: () => void) {
  for (let i = 0; i < 10; i++) work();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    work();
    times.push(performance.now() - start);
  }
  results.push({
    scenario,
    nodes,
    p50Ms: percentile(times, 0.5, 3),
    p95Ms: percentile(times, 0.95, 3),
  });
}
for (const count of [100, 1000, 5000]) {
  let document = parser(fixtures.performanceDocument(count));
  if (controlOnly) {
    measure("isolated mutable validation", count, () => {
      schema.parseDesignDocument(document);
    });
    continue;
  }
  measure("move preview", count, () => {
    const next = editing.previewMoveLayers(document, ["layer-1"], 2, 1);
    if (next.nodes[1].box.x !== document.nodes[1].box.x + 2) throw new Error("Move lost.");
  });
  measure("sparse committed edit", count, () => {
    const before = document;
    const prepared = editing.trackDocumentChanges(
      before,
      { ...before, nodes: editing.movedLayers(before, ["layer-1"], 2, 1) },
      parser,
    );
    const patch = patches.diffDocument(before, prepared);
    document = patches.applyDocumentPatch(before, patch, false, parser);
    if (document.nodes[1].box.x !== before.nodes[1].box.x + 2) throw new Error("Commit lost.");
  });
  measure("revalidate editor snapshot", count, () => {
    const next = parser(document);
    if (next.nodes.length !== count) throw new Error("Nodes lost.");
  });
  // Untrusted/mutable validation remains measured independently of the editor path.
  const mutableInput = schema.parseDesignDocument(document);
  measure("mutable full validation", count, () => {
    schema.parseDesignDocument(mutableInput);
  });
}
if (!controlOnly) {
  const linkedCount = 1500;
  let linked = parser({
    ...schema.blankDesignDocument(),
    nodes: Array.from({ length: linkedCount }, (_, index) => ({
      ...schema.buildDrawnNode(index ? `copy-${index}` : "master", "container", null, {
        x: 0,
        y: 0,
        width: 100,
        height: 32,
      }),
      ...(index
        ? { instanceOf: "master", componentSourceId: "master", instanceOverrides: [] }
        : { isComponent: true }),
    })),
  });
  let alternate = false;
  measure("linked master committed edit", linkedCount, () => {
    alternate = !alternate;
    const fill = alternate ? "#112233" : "#aabbcc";
    const before = linked;
    const next = editing.trackDocumentChanges(
      before,
      { ...before, nodes: editing.changedLayers(before, ["master"], { style: { fill } }) },
      parser,
    );
    linked = patches.applyDocumentPatch(before, patches.diffDocument(before, next), false, parser);
    if (linked.nodes.some((node) => node.style.fill !== fill)) throw new Error("Propagation lost.");
  });
}
const report = {
  runtime: `Bun ${Bun.version}`,
  cpu: cpus()[0].model,
  samples,
  warmups: 10,
  parser: controlOnly
    ? "isolated mutable control"
    : schema.parseImmutableDesignDocument
      ? "immutable editor"
      : "baseline",
  results,
};
console.log(await writeBenchmarkReport(report));
