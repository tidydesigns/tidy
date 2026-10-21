import tracer, { type TracePath, type TraceColor } from "imagetracerjs";
import {
  serializeContours,
  type VectorAnchor,
  type VectorContour,
} from "@tidy/design/vector-geometry";
import { recoverRasterOcclusion } from "./occlusion";
import { refineRasterCoverage } from "./coverage";
import { simplifyRasterPaths } from "./simplify";
import { recoverSmallRasterEllipses } from "./small-ellipses";
import { fitRasterShape } from "./shape-fit";
import { fitRasterLinearGradient, fitRasterOpacityGradient } from "./gradient";
import { traceGradientRegions } from "./gradient-regions";
import { prepareRasterRegions } from "./regions";
import { designNodeSchema } from "../document";
import { traceLimits, type TraceColors, type RasterTrace } from "./contract";

function rgbaKey(color: TraceColor) {
  return ((color.r << 24) | (color.g << 16) | (color.b << 8) | color.a) >>> 0;
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

function compactDetails(paths: RasterTrace["paths"]) {
  const result: RasterTrace["paths"] = [];
  const dense = paths.length > traceLimits.paths / 2;
  const merged = new Set<RasterTrace["paths"][number]>();
  let group: RasterTrace["paths"][number] | undefined;
  for (const path of paths) {
    const contours = path.vectorPath.contours!;
    const points = contours.flatMap((c) => c.points);
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const small =
      path.opacity === 1 &&
      !path.fill &&
      points.length <= 16 &&
      (width <= 2 || height <= 2 || (dense && contours.length === 1 && width <= 8 && height <= 8));
    if (path.opacity !== 1 || path.fill || group?.color !== path.color) group = undefined;
    if (
      small &&
      group &&
      group.vectorPath.contours!.length + contours.length <= 100 &&
      group.vectorPath.contours!.reduce((n, c) => n + c.points.length, 0) + points.length <= 1000
    ) {
      group.vectorPath.contours!.push(...contours);
      group.name = undefined;
      merged.add(group);
    } else {
      const copy = { ...path, vectorPath: { ...path.vectorPath, contours: [...contours] } };
      result.push(copy);
      if (small) group = copy;
    }
  }
  for (const path of merged) path.vectorPath.d = serializeContours(path.vectorPath.contours!);
  return result;
}

/** Worker-only CPU work. Return native contours, never untrusted SVG markup. */
export function traceRaster(
  image: { width: number; height: number; data: Uint8ClampedArray },
  colors: TraceColors,
  options: { lossy?: boolean; gradientRegions?: boolean } = {},
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
    const opacityGradient = fitRasterOpacityGradient(image);
    const gradient = opacityGradient ?? fitRasterLinearGradient(image);
    if (gradient) {
      const mask = image.data.slice();
      for (let i = 0; i < mask.length; i += 4) {
        mask[i] = mask[i + 1] = mask[i + 2] = 255;
        if (opacityGradient && mask[i + 3]) mask[i + 3] = 255;
      }
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
  if (colors === "auto" && options.gradientRegions !== false) {
    const candidate = traceGradientRegions(image, (mask) => traceRaster(mask, 32));
    if (candidate) {
      const withinBudget =
        candidate.pointCount <= traceLimits.points &&
        new TextEncoder().encode(JSON.stringify(candidate)).length <= traceLimits.bytes;
      try {
        const baseline = traceRaster({ ...image, data: image.data.slice() }, colors, {
          ...options,
          gradientRegions: false,
        });
        const { fallback, ...prepared } = baseline;
        return withinBudget ? { ...candidate, fallback: fallback ?? prepared } : baseline;
      } catch (error) {
        // A smooth opacity ramp can exceed the palette tracer's region budget.
        // Its compact model still undergoes pixel verification in the worker.
        if (withinBudget) return candidate;
        throw error;
      }
    }
  }
  const original = { ...image, data: image.data.slice() };
  const seeds = prepareRasterRegions(image, colors, !!options.lossy);
  const paletteIndices = new Map(seeds.map((color, index) => [rgbaKey(color), index]));
  const indexed = {
    palette: seeds,
    array: Array.from({ length: image.height + 2 }, () =>
      new Array<number>(image.width + 2).fill(-1),
    ),
  };
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const key =
        ((image.data[i] << 24) |
          (image.data[i + 1] << 16) |
          (image.data[i + 2] << 8) |
          image.data[i + 3]) >>>
        0;
      const index = paletteIndices.get(key);
      if (index === undefined) throw new Error("Trace region has no palette colour.");
      indexed.array[y + 1][x + 1] = index;
    }
  const result = {
    palette: seeds,
    layers: seeds.map((color, index) =>
      color.a
        ? tracer.batchtracepaths(
            tracer.internodes(
              tracer.pathscan(tracer.layeringstep(indexed, index), options.lossy ? 8 : 0),
              { rightangleenhance: true },
            ),
            1,
            1,
          )
        : [],
    ),
  };
  const paths: RasterTrace["paths"] = [];
  const fallbackPaths: RasterTrace["paths"] = [];
  const underlays: { path: RasterTrace["paths"][number]; area: number }[] = [];
  const fallbackUnderlays: typeof underlays = [];
  let pointCount = 0;
  for (let layerIndex = 0; layerIndex < result.layers.length; layerIndex++) {
    const color = result.palette[layerIndex];
    if (!color.a) continue;
    const layer = result.layers[layerIndex];
    for (const path of layer) {
      if (path.isholepath) continue;
      if (
        paths.length >= traceLimits.points / 3 ||
        path.holechildren.length > traceLimits.points / 3
      )
        throw new Error("This trace has too many shapes. Try fewer colours or a simpler image.");
      const [left, top, right, bottom] = path.boundingbox;
      const tinyRectangle =
        color.a === 255 &&
        !path.holechildren.length &&
        right - left <= 8 &&
        bottom - top <= 8 &&
        left >= 0 &&
        top >= 0 &&
        right <= image.width &&
        bottom <= image.height &&
        right > left &&
        bottom > top &&
        (() => {
          for (let y = Math.max(0, top - 1); y < Math.min(image.height, bottom + 1); y++)
            for (let x = Math.max(0, left - 1); x < Math.min(image.width, right + 1); x++) {
              const i = (y * image.width + x) * 4;
              const matches =
                original.data[i] === color.r &&
                original.data[i + 1] === color.g &&
                original.data[i + 2] === color.b &&
                original.data[i + 3] === color.a;
              const inside = x >= left && x < right && y >= top && y < bottom;
              if (inside && !matches) return false;
              if (
                !inside &&
                original.data[i + 3] > 0 &&
                Math.abs(original.data[i] - color.r) <= 16 &&
                Math.abs(original.data[i + 1] - color.g) <= 16 &&
                Math.abs(original.data[i + 2] - color.b) <= 16
              )
                return false;
            }
          return true;
        })();
      const rawContours = [path, ...path.holechildren.map((index) => layer[index])].map(
        (p, index) => contour(p, `trace-${fallbackPaths.length}-${index}`),
      );
      if (tinyRectangle)
        rawContours[0] = {
          ...rawContours[0],
          points: [
            [left, top],
            [right, top],
            [right, bottom],
            [left, bottom],
          ].map(([x, y], i) => ({
            id: `${rawContours[0].id}-${i}`,
            x,
            y,
          })),
        };
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
      const fitted = rawContours.map((raw) => {
        if (tinyRectangle) return { contour: raw, name: "Rectangle" };
        const primitive = fitRasterShape(raw);
        if (primitive.name) return primitive;
        const refined = refineRasterCoverage(raw, original, color.a);
        return refined === raw ? primitive : fitRasterShape(refined);
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
      if (underlay) {
        fallbackPath.vectorPath.contours = rawContours.slice(0, 1);
        fallbackPath.vectorPath.d = serializeContours(fallbackPath.vectorPath.contours);
      }
      if (!designNodeSchema.shape.vectorPath.safeParse(fallbackPath.vectorPath).success)
        throw new Error(
          "This trace exceeds the editable path limits. Try fewer colours or a simpler image.",
        );
      fallbackPaths.push(fallbackPath);
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
        fallbackUnderlays.push({ path: fallbackPath, area: underlays.at(-1)!.area });
      }
    }
  }
  if (!paths.length) throw new Error("No shapes survived tracing. Try a larger image.");
  const underneath = new Set(underlays.map((entry) => entry.path));
  const ordered = [
    ...underlays.sort((a, b) => b.area - a.area).map((entry) => entry.path),
    ...compactDetails(paths.filter((path) => !underneath.has(path))),
  ];
  if (ordered.length > traceLimits.paths)
    throw new Error("This trace has too many shapes. Try fewer colours or a simpler image.");
  const recovered = simplifyRasterPaths(
    recoverSmallRasterEllipses(recoverRasterOcclusion(ordered, image), original),
  );
  pointCount = recovered.reduce(
    (sum, path) => sum + path.vectorPath.contours!.reduce((n, c) => n + c.points.length, 0),
    0,
  );
  const fallbackUnderneath = new Set(fallbackUnderlays.map((entry) => entry.path));
  const fallback = {
    width: image.width,
    height: image.height,
    paths: [
      ...fallbackUnderlays.sort((a, b) => b.area - a.area).map((entry) => entry.path),
      ...compactDetails(fallbackPaths.filter((path) => !fallbackUnderneath.has(path))),
    ],
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
