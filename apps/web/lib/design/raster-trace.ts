import tracer, { type TraceColor, type TracePath } from "imagetracerjs";
import {
  serializeContours,
  type VectorAnchor,
  type VectorContour,
} from "@bella/design/vector-geometry";
import { designNodeSchema } from "./document";
import { traceLimits, type TraceColors, type RasterTrace } from "./raster-trace-contract";

/** Deterministic, frequency-weighted diverse seeds; no random sampling, hidden RGB or white removal. */
function palette(data: Uint8ClampedArray, colors: TraceColors): TraceColor[] {
  // Coverage antialiasing should become a fitted edge, not dozens of translucent fringe layers.
  // Retain alpha bands with substantial area (for example a deliberately translucent shape).
  const alphaCounts = new Uint32Array(16);
  let visiblePixels = 0;
  for (let i = 3; i < data.length; i += 4)
    if (data[i]) {
      alphaCounts[data[i] >> 4]++;
      visiblePixels++;
    }
  for (let i = 3; i < data.length; i += 4) {
    const alpha = data[i];
    if (alpha && alpha < 255 && alphaCounts[alpha >> 4] < visiblePixels * 0.01)
      data[i] = alpha < 128 ? 0 : 255;
  }
  const histogram = new Map<number, { color: TraceColor; count: number }>();
  let transparent = false;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) {
      data[i] = data[i + 1] = data[i + 2] = 0;
      transparent = true;
      continue;
    }
    const key =
      ((data[i] >> 4) << 12) |
      ((data[i + 1] >> 4) << 8) |
      ((data[i + 2] >> 4) << 4) |
      (data[i + 3] >> 4);
    const entry = histogram.get(key);
    if (entry) entry.count++;
    else
      histogram.set(key, {
        color: { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] },
        count: 1,
      });
  }
  const sorted = [...histogram.values()].sort((a, b) => b.count - a.count);
  // Do not spend the requested palette on isolated compression noise or edge colours.
  const remaining = sorted.filter(
    (entry, index) => index === 0 || entry.count >= Math.max(4, visiblePixels * 0.003),
  );
  const chosen: TraceColor[] = transparent ? [{ r: 0, g: 0, b: 0, a: 0 }] : [];
  const distance = (a: TraceColor, b: TraceColor) =>
    Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a);
  if (remaining.length) chosen.push(remaining.shift()!.color);
  while (remaining.length && chosen.length < colors + Number(transparent)) {
    for (let i = remaining.length - 1; i >= 0; i--)
      if (chosen.some((color) => color.a > 0 && distance(color, remaining[i].color) < 48))
        remaining.splice(i, 1);
    if (!remaining.length) break;
    let best = 0,
      score = -1;
    for (let i = 0; i < remaining.length; i++) {
      const entry = remaining[i];
      const value =
        Math.min(...chosen.map((color) => distance(color, entry.color))) * Math.sqrt(entry.count);
      if (value > score) {
        best = i;
        score = value;
      }
    }
    chosen.push(remaining.splice(best, 1)[0].color);
  }
  return chosen;
}

function contour(path: TracePath, id: string): VectorContour {
  if (!path.segments.length || path.segments.length > 1000)
    throw new Error("This trace has too many points. Try fewer colours or a simpler image.");
  const first = path.segments[0];
  const points: VectorAnchor[] = [{ id: `${id}-0`, x: first.x1, y: first.y1 }];
  for (const segment of path.segments) {
    const previous = points.at(-1)!;
    const next: VectorAnchor = {
      id: `${id}-${points.length}`,
      x: segment.type === "Q" ? segment.x3 : segment.x2,
      y: segment.type === "Q" ? segment.y3 : segment.y2,
    };
    if (segment.type === "Q") {
      previous.out = {
        x: previous.x + (2 / 3) * (segment.x2 - previous.x),
        y: previous.y + (2 / 3) * (segment.y2 - previous.y),
      };
      next.in = {
        x: next.x + (2 / 3) * (segment.x2 - next.x),
        y: next.y + (2 / 3) * (segment.y2 - next.y),
      };
    }
    points.push(next);
  }
  const last = points.at(-1)!;
  if (last.x === points[0].x && last.y === points[0].y) {
    points[0].in = last.in;
    points.pop();
  }
  return { id, closed: true, points };
}

/** Worker-only CPU work. Return native contours, never untrusted SVG markup. */
export function traceRaster(
  image: { width: number; height: number; data: Uint8ClampedArray },
  colors: TraceColors,
): RasterTrace {
  if (![2, 8, 16].includes(colors)) throw new Error("Choose 2, 8 or 16 colours.");
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width > traceLimits.edge ||
    image.height > traceLimits.edge ||
    image.width * image.height > traceLimits.pixels ||
    image.data.length !== image.width * image.height * 4
  )
    throw new Error("Trace input exceeds the pixel limit.");
  const seeds = palette(image.data, colors);
  if (!seeds.some((color) => color.a > 0))
    throw new Error("This image has no visible pixels to trace.");
  const result = tracer.imagedataToTracedata(image, {
    pal: seeds,
    colorsampling: 0,
    colorquantcycles: 3,
    mincolorratio: 0,
    layering: 0,
    ltres: 1,
    qtres: 1,
    pathomit: 8,
    rightangleenhance: true,
    blurradius: 0,
    strokewidth: 0,
  });
  const paths: RasterTrace["paths"] = [];
  let pointCount = 0;
  for (let layerIndex = 0; layerIndex < result.layers.length; layerIndex++) {
    const color = result.palette[layerIndex];
    if (!color.a) continue;
    const layer = result.layers[layerIndex];
    for (const path of layer) {
      if (path.isholepath) continue;
      if (paths.length >= traceLimits.paths || path.holechildren.length >= 100)
        throw new Error("This trace has too many shapes. Try fewer colours or a simpler image.");
      const contours = [path, ...path.holechildren.map((index) => layer[index])].map((p, index) =>
        contour(p, `trace-${paths.length}-${index}`),
      );
      pointCount += contours.reduce((sum, c) => sum + c.points.length, 0);
      if (pointCount > traceLimits.points)
        throw new Error("This trace has too many points. Try fewer colours or a simpler image.");
      const vectorPath = {
        d: serializeContours(contours),
        contours,
        viewBox: { x: 0, y: 0, width: image.width, height: image.height },
        fillRule: "evenodd" as const,
      };
      // Reuse exactly the limits enforced by document persistence and the point editor.
      const checked = designNodeSchema.shape.vectorPath.safeParse(vectorPath);
      if (!checked.success)
        throw new Error(
          "This trace exceeds the editable path limits. Try fewer colours or a simpler image.",
        );
      paths.push({
        vectorPath,
        color: `#${[color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
        opacity: color.a / 255,
      });
    }
  }
  if (!paths.length) throw new Error("No shapes survived tracing. Try a larger image.");
  const trace = { width: image.width, height: image.height, paths, pointCount };
  if (new TextEncoder().encode(JSON.stringify(trace)).length > traceLimits.bytes)
    throw new Error("This trace is too large for the canvas. Try fewer colours.");
  return trace;
}
