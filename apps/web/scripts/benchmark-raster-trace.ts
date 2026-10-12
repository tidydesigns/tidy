import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { traceRaster } from "../lib/design/raster-trace";
import { traceSize, type RasterTrace, type TraceColors } from "../lib/design/raster-trace-contract";

const output = process.env.RASTER_TRACE_BENCH_OUTPUT ?? "/tmp/tidy-raster-trace-benchmark";
await mkdir(output, { recursive: true });
const fixtures = [
  {
    name: "logo-holes",
    body: '<path fill="#e43d30" fill-rule="evenodd" d="M35 30H155V220H35ZM65 70V180H125V70Z"/><circle fill="#286ccf" cx="220" cy="128" r="65"/>',
  },
  {
    name: "rounded-icon",
    body: '<rect x="32" y="32" width="190" height="190" rx="48" fill="#287864"/><circle cx="128" cy="128" r="50" fill="#ffffff"/>',
  },
  {
    name: "gradient",
    body: '<defs><linearGradient id="g"><stop stop-color="#26396c"/><stop offset="1" stop-color="#f3b187"/></linearGradient></defs><rect width="320" height="256" fill="url(#g)"/><circle cx="170" cy="130" r="65" fill="#ffffff" fill-opacity=".35"/>',
  },
  {
    name: "fine-details",
    body: Array.from(
      { length: 120 },
      (_, i) =>
        `<circle cx="${12 + (i % 15) * 20}" cy="${12 + Math.floor(i / 15) * 30}" r="5" fill="${i % 2 ? "#dd5522" : "#2266cc"}"/>`,
    ).join(""),
  },
];
function svg(trace: RasterTrace) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${trace.width}" height="${trace.height}">${trace.paths.map((p) => `<path d="${p.vectorPath.d}" fill="${p.color}" fill-opacity="${p.opacity}" fill-rule="${p.vectorPath.fillRule}"/>`).join("")}</svg>`;
}
const rows = [];
for (const fixture of fixtures)
  for (const format of ["png", "jpeg"] as const)
    for (const colors of [2, 8, 16] as TraceColors[]) {
      const pipeline = sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="256">${fixture.body}</svg>`,
        ),
      );
      if (format === "jpeg") pipeline.flatten({ background: "#ffffff" });
      const encoded = await pipeline[format]().toBuffer();
      const { data, info } = await sharp(encoded)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const times = [];
      let result: RasterTrace | undefined, error: string | undefined;
      for (let i = 0; i < 6; i++) {
        const start = performance.now();
        try {
          result = traceRaster(
            { width: info.width, height: info.height, data: new Uint8ClampedArray(data) },
            colors,
          );
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
          break;
        }
        if (i) times.push(performance.now() - start);
      }
      if (!result || error) {
        rows.push({ fixture: fixture.name, format, colors, error });
        continue;
      }
      const markup = svg(result);
      const rendered = await sharp(Buffer.from(markup)).ensureAlpha().raw().toBuffer();
      // Compare composited white-background channels so invisible RGB does not skew the metric.
      let difference = 0;
      for (let i = 0; i < data.length; i += 4)
        for (let c = 0; c < 3; c++) {
          const a = (data[i + c] * data[i + 3]) / 255 + 255 - data[i + 3];
          const b = (rendered[i + c] * rendered[i + 3]) / 255 + 255 - rendered[i + 3];
          difference += Math.abs(a - b);
        }
      const row = {
        fixture: fixture.name,
        format,
        colors,
        medianMs: Number(times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(2)),
        paths: result.paths.length,
        points: result.pointCount,
        svgBytes: Buffer.byteLength(markup),
        documentBytes: Buffer.byteLength(JSON.stringify(result)),
        meanChannelError: Number((difference / (info.width * info.height * 3)).toFixed(3)),
      };
      rows.push(row);
      if (colors === 8) {
        await writeFile(join(output, `${fixture.name}.${format}`), encoded);
        await writeFile(join(output, `${fixture.name}-${format}.svg`), markup);
      }
    }
const report = {
  measuredAt: new Date().toISOString(),
  runtime: Bun.version,
  platform: `${process.platform}/${process.arch}`,
  samples: 5,
  warmups: 1,
  workingSizeExample: traceSize(5000, 5000),
  rows,
};
await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
console.table(rows);
console.log(`Synthetic trace measurements saved to ${output}`);
