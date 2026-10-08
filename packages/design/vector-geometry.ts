export type VectorPoint = { x: number; y: number };
export type VectorAnchor = VectorPoint & {
  id: string;
  in?: VectorPoint;
  out?: VectorPoint;
  mode?: "corner" | "smooth" | "symmetric";
};
export type VectorContour = { id: string; closed: boolean; points: VectorAnchor[] };

const xy = (p: VectorPoint) => `${Number(p.x.toFixed(6))} ${Number(p.y.toFixed(6))}`;
export function segmentPath(a: VectorAnchor, b: VectorAnchor): string {
  return a.out || b.in ? `C ${xy(a.out ?? a)} ${xy(b.in ?? b)} ${xy(b)}` : `L ${xy(b)}`;
}
export function serializeContours(contours: VectorContour[]): string {
  return contours
    .map(({ points, closed }) => {
      if (!points.length) return "";
      let d = `M ${xy(points[0]!)}`;
      for (let i = 1; i < points.length; i++) d += ` ${segmentPath(points[i - 1]!, points[i]!)}`;
      if (closed) {
        if (points.at(-1)!.out || points[0]!.in) d += ` ${segmentPath(points.at(-1)!, points[0]!)}`;
        d += " Z";
      }
      return d;
    })
    .join(" ");
}

/** SVG endpoint arcs become cubic segments of at most 90 degrees. */
function arcSegments(
  start: VectorPoint,
  end: VectorPoint,
  rx: number,
  ry: number,
  rotation: number,
  large: number,
  sweep: number,
) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry || (start.x === end.x && start.y === end.y)) return [];
  const phi = (rotation * Math.PI) / 180,
    c = Math.cos(phi),
    s = Math.sin(phi);
  const xp = (c * (start.x - end.x)) / 2 + (s * (start.y - end.y)) / 2;
  const yp = (-s * (start.x - end.x)) / 2 + (c * (start.y - end.y)) / 2;
  const scale = Math.sqrt((xp * xp) / (rx * rx) + (yp * yp) / (ry * ry));
  if (scale > 1) {
    rx *= scale;
    ry *= scale;
  }
  const factor =
    (large === sweep ? -1 : 1) *
    Math.sqrt(
      Math.max(
        0,
        (rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp) /
          (rx * rx * yp * yp + ry * ry * xp * xp),
      ),
    );
  const cxp = (factor * rx * yp) / ry,
    cyp = (-factor * ry * xp) / rx;
  const cx = c * cxp - s * cyp + (start.x + end.x) / 2;
  const cy = s * cxp + c * cyp + (start.y + end.y) / 2;
  const angle = Math.atan2((yp - cyp) / ry, (xp - cxp) / rx);
  const endAngle = Math.atan2((-yp - cyp) / ry, (-xp - cxp) / rx);
  let delta = endAngle - angle;
  if (sweep && delta < 0) delta += Math.PI * 2;
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  const count = Math.ceil(Math.abs(delta) / (Math.PI / 2));
  const point = (t: number): VectorPoint => ({
    x: cx + c * rx * Math.cos(t) - s * ry * Math.sin(t),
    y: cy + s * rx * Math.cos(t) + c * ry * Math.sin(t),
  });
  const tangent = (t: number): VectorPoint => ({
    x: -c * rx * Math.sin(t) - s * ry * Math.cos(t),
    y: -s * rx * Math.sin(t) + c * ry * Math.cos(t),
  });
  return Array.from({ length: count }, (_, i) => {
    const a = angle + (delta * i) / count,
      b = angle + (delta * (i + 1)) / count;
    const p = point(a),
      q = point(b),
      u = tangent(a),
      v = tangent(b),
      k = (4 / 3) * Math.tan((b - a) / 4);
    return {
      out: { x: p.x + u.x * k, y: p.y + u.y * k },
      in: { x: q.x - v.x * k, y: q.y - v.y * k },
      end: i === count - 1 ? end : q,
    };
  });
}

/** Parse the SVG path grammar, including relative/repeated commands and compact arc flags. */
export function parsePathContours(d: string): VectorContour[] {
  let index = 0,
    command = "",
    previous = "",
    cursor: VectorPoint = { x: 0, y: 0 },
    quadratic: VectorPoint | undefined;
  const contours: VectorContour[] = [];
  let contour: VectorContour | undefined,
    serial = 0;
  const skip = () => {
    while (/[\s,]/.test(d[index] ?? "!") && index < d.length) index++;
  };
  const number = () => {
    skip();
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(index));
    if (!match) throw new Error("Invalid SVG path number.");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value) || Math.abs(value) > 100000)
      throw new Error("Path coordinate exceeds limits.");
    return value;
  };
  const flag = () => {
    skip();
    const value = d[index++];
    if (value !== "0" && value !== "1") throw new Error("Invalid arc flag.");
    return Number(value);
  };
  const anchor = (p: VectorPoint): VectorAnchor => ({ id: `p${++serial}`, ...p });
  const append = (p: VectorPoint, incoming?: VectorPoint, outgoing?: VectorPoint) => {
    if (!contour || contour.closed) throw new Error("Start a contour with M.");
    if (outgoing) contour.points.at(-1)!.out = outgoing;
    contour.points.push({ ...anchor(p), ...(incoming ? { in: incoming } : {}) });
    cursor = p;
    if (serial > 1000) throw new Error("Path has too many points.");
  };
  while (true) {
    skip();
    if (index >= d.length) break;
    if (/[a-zA-Z]/.test(d[index]!)) command = d[index++]!;
    else if (!command) throw new Error("Missing SVG path command.");
    const upper = command.toUpperCase(),
      relative = command !== upper;
    if (contour?.closed && upper !== "M" && upper !== "Z") {
      contour = { id: `s${contours.length + 1}`, closed: false, points: [anchor(cursor)] };
      contours.push(contour);
      if (contours.length > 100) throw new Error("Path has too many contours.");
    }
    const origin = cursor;
    const point = (): VectorPoint => {
      const x = number(),
        y = number();
      return { x: x + (relative ? origin.x : 0), y: y + (relative ? origin.y : 0) };
    };
    const tail = contour?.points.at(-1);
    if (upper === "M") {
      cursor = point();
      contour = { id: `s${contours.length + 1}`, closed: false, points: [anchor(cursor)] };
      contours.push(contour);
      if (contours.length > 100) throw new Error("Path has too many contours.");
      command = relative ? "l" : "L";
    } else if (upper === "Z") {
      if (!contour || contour.closed) throw new Error("Invalid closed contour.");
      const first = contour.points[0]!,
        last = contour.points.at(-1)!;
      if (contour.points.length > 1 && Math.hypot(last.x - first.x, last.y - first.y) < 0.000001) {
        if (last.in) first.in = last.in;
        contour.points.pop();
      }
      contour.closed = true;
      cursor = { x: first.x, y: first.y };
      command = "";
    } else if (upper === "L") append(point());
    else if (upper === "H") append({ x: number() + (relative ? origin.x : 0), y: origin.y });
    else if (upper === "V") append({ x: origin.x, y: number() + (relative ? origin.y : 0) });
    else if (upper === "C" || upper === "S") {
      const out =
        upper === "C"
          ? point()
          : /[CS]/.test(previous) && tail?.in
            ? { x: 2 * origin.x - tail.in.x, y: 2 * origin.y - tail.in.y }
            : origin;
      const incoming = point(),
        end = point();
      append(end, incoming, out);
    } else if (upper === "Q" || upper === "T") {
      const control: VectorPoint =
        upper === "Q"
          ? point()
          : /[QT]/.test(previous) && quadratic
            ? { x: 2 * origin.x - quadratic.x, y: 2 * origin.y - quadratic.y }
            : origin;
      const end = point();
      append(
        end,
        { x: end.x + ((control.x - end.x) * 2) / 3, y: end.y + ((control.y - end.y) * 2) / 3 },
        {
          x: origin.x + ((control.x - origin.x) * 2) / 3,
          y: origin.y + ((control.y - origin.y) * 2) / 3,
        },
      );
      quadratic = control;
    } else if (upper === "A") {
      const rx = number(),
        ry = number(),
        rotation = number(),
        large = flag(),
        sweep = flag(),
        end = point();
      const segments = arcSegments(origin, end, rx, ry, rotation, large, sweep);
      if (!rx || !ry) append(end);
      else for (const segment of segments) append(segment.end, segment.in, segment.out);
    } else throw new Error("Unsupported SVG path command.");
    previous = upper;
    if (!/[QT]/.test(upper)) quadratic = undefined;
  }
  if (!contours.length) throw new Error("Empty SVG path.");
  return contours;
}

export function moveVectorPoint(
  contours: VectorContour[],
  id: string,
  control: "anchor" | "in" | "out",
  target: VectorPoint,
): VectorContour[] {
  return contours.map((c) => ({
    ...c,
    points: c.points.map((p) => {
      if (p.id !== id) return p;
      if (control === "anchor") {
        const dx = target.x - p.x,
          dy = target.y - p.y;
        return {
          ...p,
          ...target,
          ...(p.in ? { in: { x: p.in.x + dx, y: p.in.y + dy } } : {}),
          ...(p.out ? { out: { x: p.out.x + dx, y: p.out.y + dy } } : {}),
        };
      }
      const opposite = control === "in" ? "out" : "in",
        result = { ...p, [control]: target };
      if (p.mode === "smooth" || p.mode === "symmetric") {
        const dx = p.x - target.x,
          dy = p.y - target.y,
          length = Math.hypot(dx, dy);
        const scale =
          p.mode === "symmetric"
            ? 1
            : length && p[opposite]
              ? Math.hypot(p[opposite]!.x - p.x, p[opposite]!.y - p.y) / length
              : 1;
        result[opposite] = { x: p.x + dx * scale, y: p.y + dy * scale };
      }
      return result;
    }),
  }));
}

const mid = (a: VectorPoint, b: VectorPoint): VectorPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
/** De Casteljau subdivision preserves the curve exactly. */
export function splitVectorSegment(
  contours: VectorContour[],
  contourId: string,
  index: number,
  id: string,
): VectorContour[] {
  return contours.map((c) => {
    if (c.id !== contourId) return c;
    const a = c.points[index],
      b = c.points[(index + 1) % c.points.length];
    if (!a || !b || (!c.closed && index === c.points.length - 1)) return c;
    const points = c.points.map((p) => ({ ...p }));
    let added: VectorAnchor;
    if (a.out || b.in) {
      const u = mid(a, a.out ?? a),
        v = mid(a.out ?? a, b.in ?? b),
        w = mid(b.in ?? b, b);
      const incoming = mid(u, v),
        outgoing = mid(v, w);
      points[index]!.out = u;
      points[(index + 1) % points.length]!.in = w;
      added = { id, ...mid(incoming, outgoing), in: incoming, out: outgoing, mode: "smooth" };
    } else added = { id, ...mid(a, b), mode: "corner" };
    points.splice(index + 1, 0, added);
    return { ...c, points };
  });
}

export function setVectorPointMode(
  contours: VectorContour[],
  id: string,
  mode: NonNullable<VectorAnchor["mode"]>,
): VectorContour[] {
  return contours.map((c) => ({
    ...c,
    points: c.points.map((p, i) => {
      if (p.id !== id) return p;
      if (mode === "corner") return { ...p, mode };
      const before = c.points[i - 1] ?? (c.closed ? c.points.at(-1) : p)!;
      const after = (c.points[i + 1] ?? (c.closed ? c.points[0] : p))!;
      const dx = after.x - before.x,
        dy = after.y - before.y,
        length = Math.hypot(dx, dy) || 1;
      const outgoing = p.out ?? { x: p.x + dx / 3, y: p.y + dy / 3 };
      const vx = outgoing.x - p.x,
        vy = outgoing.y - p.y,
        outLength = Math.hypot(vx, vy);
      const inLength =
        mode === "symmetric"
          ? outLength
          : p.in
            ? Math.hypot(p.in.x - p.x, p.in.y - p.y)
            : Math.hypot(p.x - before.x, p.y - before.y) / 3;
      return {
        ...p,
        mode,
        out: outgoing,
        in: {
          x: p.x - (outLength ? vx / outLength : dx / length) * inLength,
          y: p.y - (outLength ? vy / outLength : dy / length) * inLength,
        },
      };
    }),
  }));
}
