import type { DesignNode } from "./document";

export type MeasuredBoxes = ReadonlyMap<string, DesignNode["box"]>;
type Matrix = { a: number; b: number; c: number; d: number; x: number; y: number };
const identity: Matrix = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
function multiply(p: Matrix, q: Matrix): Matrix {
  return {
    a: p.a * q.a + p.c * q.b,
    b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d,
    d: p.b * q.c + p.d * q.d,
    x: p.a * q.x + p.c * q.y + p.x,
    y: p.b * q.x + p.d * q.y + p.y,
  };
}
function inverse(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    x: (m.c * m.y - m.d * m.x) / det,
    y: (m.b * m.x - m.a * m.y) / det,
  };
}
const translate = (x: number, y: number): Matrix => ({ ...identity, x, y });
function local(node: DesignNode, box: DesignNode["box"]): Matrix {
  const angle = ((node.style.rotation ?? 0) * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  const x = node.style.flipX ? -1 : 1,
    y = node.style.flipY ? -1 : 1;
  return multiply(
    multiply(translate(box.x + box.width / 2, box.y + box.height / 2), {
      a: cos * x,
      b: sin * x,
      c: -sin * y,
      d: cos * y,
      x: 0,
      y: 0,
    }),
    translate(-box.width / 2, -box.height / 2),
  );
}

/** Preserve the visual rectangle when moving between rotated/flipped parent spaces.
 * Measurements replace stored flow/fill geometry; without DOM measurements this
 * also supports deterministic free-layout model and clipboard operations.
 */
export function reparentGeometry(
  nodes: DesignNode[],
  node: DesignNode,
  parentId: string | null,
  boxes?: MeasuredBoxes,
  nodeBox?: DesignNode["box"],
) {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const cache = new Map<string, Matrix>(),
    visiting = new Set<string>();
  function world(item: DesignNode): Matrix {
    const cached = cache.get(item.id);
    if (cached) return cached;
    if (visiting.has(item.id)) throw new Error("A layer cannot be placed inside itself.");
    visiting.add(item.id);
    const value = multiply(children(item.parentId), local(item, boxes?.get(item.id) ?? item.box));
    visiting.delete(item.id);
    cache.set(item.id, value);
    return value;
  }
  function children(id: string | null): Matrix {
    const item = id ? byId.get(id) : undefined;
    if (!item) return identity;
    const border = item.style.borderWidth ?? 0;
    return multiply(
      world(item),
      translate(item.style.borderLeftWidth ?? border, item.style.borderTopWidth ?? border),
    );
  }
  const box = nodeBox ?? boxes?.get(node.id) ?? node.box;
  const parentTransform = multiply(inverse(children(parentId)), children(node.parentId));
  const transform = multiply(parentTransform, local(node, box));
  const cx = (transform.a * box.width) / 2 + (transform.c * box.height) / 2 + transform.x;
  const cy = (transform.b * box.width) / 2 + (transform.d * box.height) / 2 + transform.y;
  const clean = (n: number) => (Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e9) / 1e9);
  const orientation = (value: Matrix, explicit = false) => ({
    rotation: clean((Math.atan2(value.b, value.a) * 180) / Math.PI) || (explicit ? 0 : undefined),
    flipX: explicit ? false : undefined,
    flipY: value.a * value.d - value.b * value.c < 0 || (explicit ? false : undefined),
  });
  return {
    box: {
      x: clean(cx - box.width / 2),
      y: clean(cy - box.height / 2),
      width: box.width,
      height: box.height,
    },
    style: { ...node.style, ...orientation(transform) },
    ...(node.variants
      ? {
          variants: {
            ...node.variants,
            options: Object.fromEntries(
              Object.entries(node.variants.options).map(([name, option]) => [
                name,
                {
                  ...option,
                  root: {
                    ...option.root,
                    style: {
                      ...option.root?.style,
                      ...orientation(
                        multiply(
                          parentTransform,
                          local({ ...node, style: { ...node.style, ...option.root?.style } }, box),
                        ),
                        true,
                      ),
                    },
                  },
                },
              ]),
            ),
          },
        }
      : {}),
  };
}
