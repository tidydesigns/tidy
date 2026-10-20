/** Synthetic only: no credentials, network access or database required.
 * Run from the repository root: bun apps/web/scripts/benchmark-visual-preview.ts
 */
import { blankDesignDocument, designNodeSchema, parseDesignDocument } from "@tidy/design/document";
import { visualPreviewViews } from "../lib/design/visual-preview";
import { packagePreviewFonts } from "../lib/design/visual-preview-fonts";
import { layoutReport } from "../lib/design/layout-diagnostics";

function fixture(components: number, unrelatedNodes: number) {
  const node = designNodeSchema.parse({
    id: "frame",
    name: "Frame",
    type: "artboard",
    parentId: null,
    box: { x: 0, y: 0, width: 1200, height: 800 },
    layout: "absolute",
  });
  const nodes = [node];
  for (let i = 0; i < components; i++) {
    const id = `component-${i}`,
      label = `label-${i}`;
    nodes.push({
      ...node,
      id,
      name: id,
      type: "container",
      parentId: "frame",
      isComponent: true,
      variants: {
        default: "default",
        options: {
          default: {},
          alternate: { children: { [label]: { text: "Alternate" } } },
          hover: { root: { style: { fill: "#eeeeee" } } },
          pressed: { root: { style: { fill: "#dddddd" } } },
        },
      },
    });
    for (let j = 0; j < 5; j++)
      nodes.push({
        ...node,
        id: j === 0 ? label : `${label}-${j}`,
        name: "Label",
        type: "text",
        parentId: id,
        text: "Preview text",
        style: { fontFamily: "system-ui", fontSize: 14 },
      });
  }
  for (let i = 0; i < unrelatedNodes; i++)
    nodes.push({
      ...node,
      id: `unrelated-${i}`,
      name: "Unrelated",
      type: "container",
      parentId: null,
    });
  return parseDesignDocument({ ...blankDesignDocument(), nodes });
}

async function measure<T>(run: () => T | Promise<T>) {
  const cpu = process.cpuUsage(),
    start = performance.now();
  const value = await run();
  const used = process.cpuUsage(cpu);
  return {
    value,
    wallMs: +(performance.now() - start).toFixed(2),
    cpuMs: +((used.user + used.system) / 1000).toFixed(2),
  };
}

const noNetwork = async (): Promise<Response> => {
  throw new Error("Unexpected font fetch");
};
const iterations = Number(process.env.PREVIEW_BENCH_ITERATIONS ?? 3);
// Compile lazy schemas before timing. Each timed export still parses its input.
fixture(1, 0);
for (const [components, unrelated] of [
  [10, 0],
  [50, 2000],
  [100, 5000],
]) {
  const document = fixture(components, unrelated);
  const selections = [{ node_id: "frame" }];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const views = await measure(() => visualPreviewViews(document, selections));
    const fonts = await measure(() =>
      packagePreviewFonts(
        views.value.map((v) => v.document),
        noNetwork,
      ),
    );
    const layout = await measure(() => layoutReport(document));
    const multi = await measure(() =>
      visualPreviewViews(
        document,
        Array.from({ length: 12 }, (_, i) => ({ node_id: `component-${i % components}` })),
      ),
    );
    console.log(
      JSON.stringify({
        components,
        nodes: document.nodes.length,
        iteration,
        stages: Object.fromEntries(
          Object.entries({ views, fonts, layout, multi }).map(([key, result]) => [
            key,
            { wallMs: result.wallMs, cpuMs: result.cpuMs },
          ]),
        ),
        selectedNodes: views.value[0].document.nodes.length,
      }),
    );
  }
}
