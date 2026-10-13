import tracer, { type TracePath } from "imagetracerjs";
import {
  serializeContours,
  type VectorAnchor,
  type VectorContour,
} from "@bella/design/vector-geometry";
import { recoverRasterOcclusion } from "./raster-occlusion";
import { refineRasterCoverage } from "./raster-coverage";
import { fitRasterShape } from "./raster-shape-fit";
import { fitRasterLinearGradient } from "./raster-gradient";
import { prepareRasterRegions } from "./raster-regions";
import { designNodeSchema } from "./document";
import { traceLimits, type TraceColors, type RasterTrace } from "./raster-trace-contract";

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
  options: { lossy?: boolean } = {},
): RasterTrace {
  if (!["auto", 2, 8, 16, 32].includes(colors))
    throw new Error("Choose Auto, 2, 8, 16 or 32 colours.");
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
  if (colors === "auto") {
    const gradient = fitRasterLinearGradient(image);
    if (gradient) {
      const mask = image.data.slice();
      for (let i = 0; i < mask.length; i += 4) mask[i] = mask[i + 1] = mask[i + 2] = 255;
      const silhouette = traceRaster({ ...image, data: mask }, 2);
      const paint = (path: RasterTrace["paths"][number]) => ({
        ...path,
        opacity: gradient.opacity,
        fill: gradient.fill,
      });
      if (silhouette.paths.length === 1)
        return {
          ...silhouette,
          paths: silhouette.paths.map(paint),
          fallback: silhouette.fallback && {
            ...silhouette.fallback,
            paths: silhouette.fallback.paths.map(paint),
          },
        };
    }
  }
  const original = { ...image, data: image.data.slice() };
  const seeds = prepareRasterRegions(image, colors, !!options.lossy);
  const result = tracer.imagedataToTracedata(image, {
    pal: seeds,
    colorsampling: 0,
    colorquantcycles: 1,
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
  const fallbackPaths: RasterTrace["paths"] = [];
  const underlays: { path: RasterTrace["paths"][number]; area: number }[] = [];
  let pointCount = 0;
  for (let layerIndex = 0; layerIndex < result.layers.length; layerIndex++) {
    const color = result.palette[layerIndex];
    if (!color.a) continue;
    const layer = result.layers[layerIndex];
    for (const path of layer) {
      if (path.isholepath) continue;
      if (paths.length >= traceLimits.paths || path.holechildren.length >= 100)
        throw new Error("This trace has too many shapes. Try fewer colours or a simpler image.");
      const rawContours = [path, ...path.holechildren.map((index) => layer[index])].map(
        (p, index) => contour(p, `trace-${paths.length}-${index}`),
      );
      const fallbackPath = {
        vectorPath: {
          d: serializeContours(rawContours),
          contours: rawContours,
          viewBox: { x: 0, y: 0, width: image.width, height: image.height },
          fillRule: "evenodd" as const,
        },
        color: `#${[color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
        opacity: color.a / 255,
      };
      if (!designNodeSchema.shape.vectorPath.safeParse(fallbackPath.vectorPath).success)
        throw new Error(
          "This trace exceeds the editable path limits. Try fewer colours or a simpler image.",
        );
      fallbackPaths.push(fallbackPath);
      const fitted = [path, ...path.holechildren.map((index) => layer[index])].map((p, index) => {
        const raw = contour(p, `trace-${paths.length}-${index}`);
        const primitive = fitRasterShape(raw);
        return primitive.name
          ? primitive
          : fitRasterShape(refineRasterCoverage(raw, original, color.a));
      });
      // Recover an opaque primitive behind enclosed opaque artwork. A rounded
      // background with a leaf on it should remain a complete background when the
      // leaf moves. Transparent holes and translucent overlaps must stay untouched.
      const underlay =
        color.a === 255 &&
        ["Ellipse", "Rectangle", "Rounded rectangle", "Triangle"].includes(fitted[0].name ?? "") &&
        fitted.length > 1 &&
        fitted.slice(1).every(({ contour: hole }) => {
          const xs = hole.points.map((p) => p.x),
            ys = hole.points.map((p) => p.y);
          const left = Math.max(0, Math.floor(Math.min(...xs))),
            right = Math.min(image.width - 1, Math.ceil(Math.max(...xs)));
          const top = Math.max(0, Math.floor(Math.min(...ys))),
            bottom = Math.min(image.height - 1, Math.ceil(Math.max(...ys)));
          for (let y = top; y <= bottom; y++)
            for (let x = left; x <= right; x++)
              if (image.data[(y * image.width + x) * 4 + 3] !== 255) return false;
          return true;
        });
      const contours = (underlay ? fitted.slice(0, 1) : fitted).map((p) => p.contour);
      const outer = contours[0].points;
      // A closed line has no fill. Do not create an invisible layer for a collapsed
      // raster speck; two-anchor curves can still enclose genuine visible geometry.
      if (
        !outer.some((point) => point.in || point.out) &&
        Math.abs(
          outer.reduce((sum, point, i) => {
            const next = outer[(i + 1) % outer.length];
            return sum + point.x * next.y - next.x * point.y;
          }, 0),
        ) < 0.000001
      )
        continue;
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
      const tracedPath = {
        name: fitted[0].name,
        vectorPath,
        color: `#${[color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
        opacity: color.a / 255,
      };
      paths.push(tracedPath);
      if (underlay) {
        const xs = contours[0].points.map((p) => p.x),
          ys = contours[0].points.map((p) => p.y);
        underlays.push({
          path: tracedPath,
          area: (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)),
        });
      }
    }
  }
  if (!paths.length) throw new Error("No shapes survived tracing. Try a larger image.");
  const underneath = new Set(underlays.map((entry) => entry.path));
  const ordered = [
    ...underlays.sort((a, b) => b.area - a.area).map((entry) => entry.path),
    ...paths.filter((path) => !underneath.has(path)),
  ];
  const recovered = recoverRasterOcclusion(ordered, image);
  pointCount = recovered.reduce(
    (sum, path) => sum + path.vectorPath.contours!.reduce((n, c) => n + c.points.length, 0),
    0,
  );
  const fallback = {
    width: image.width,
    height: image.height,
    paths: fallbackPaths,
    pointCount: fallbackPaths.reduce(
      (sum, path) => sum + path.vectorPath.contours!.reduce((n, c) => n + c.points.length, 0),
      0,
    ),
  };
  const preparedTrace = {
    width: image.width,
    height: image.height,
    paths: recovered,
    pointCount,
  };
  const trace = { ...preparedTrace, fallback };
  if (
    fallback.pointCount > traceLimits.points ||
    new TextEncoder().encode(JSON.stringify(fallback)).length > traceLimits.bytes
  )
    throw new Error("This trace is too large to verify. Try fewer colours or a simpler image.");
  if (new TextEncoder().encode(JSON.stringify(preparedTrace)).length > traceLimits.bytes)
    throw new Error("This trace is too large for the canvas. Try fewer colours.");
  return trace;
}
