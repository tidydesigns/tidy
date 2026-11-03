import { createHash } from "node:crypto";
import { z } from "zod";
import type { DesignDocument } from "@tidy/design/document";
import type { DocumentPatch } from "@tidy/editor/design/document-patch";

const orderSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    placements: z
      .array(z.object({ id: z.string(), previous: z.string().nullable() }).strict())
      .max(10000),
  })
  .strict();
const idsSchema = z.array(z.string());
const digest = (ids: string[]) => createHash("sha256").update(JSON.stringify(ids)).digest("hex");

function stableIds(before: string[], after: string[]) {
  const ranks = new Map(before.map((id, index) => [id, index]));
  const common = after.filter((id) => ranks.has(id));
  const tails: number[] = [];
  const previous = new Map<number, number>();
  for (let index = 0; index < common.length; index++) {
    const rank = ranks.get(common[index])!;
    let low = 0,
      high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ranks.get(common[tails[middle]])! < rank) low = middle + 1;
      else high = middle;
    }
    if (low) previous.set(index, tails[low - 1]);
    tails[low] = index;
  }
  const stable = new Set<string>();
  for (let index = tails.at(-1); index !== undefined; index = previous.get(index))
    stable.add(common[index]);
  return stable;
}

export function compactCanvasPatch(patch: DocumentPatch): DocumentPatch {
  return patch.map((change) => {
    if (
      change.collection === "document" &&
      change.path.length === 1 &&
      ["editedNodeIds", "deletedSourceKeys"].includes(change.path[0]) &&
      Array.isArray(change.before.value) &&
      Array.isArray(change.after.value)
    ) {
      const beforeKeys = new Set(change.before.value.map((value) => JSON.stringify(value)));
      const afterKeys = new Set(change.after.value.map((value) => JSON.stringify(value)));
      return {
        ...change,
        before: {
          exists: true,
          value: change.before.value.filter((value) => !afterKeys.has(JSON.stringify(value))),
        },
        after: {
          exists: true,
          value: change.after.value.filter((value) => !beforeKeys.has(JSON.stringify(value))),
        },
      };
    }
    if (change.id || change.path.length !== 1 || change.path[0] !== "$order") return change;
    const before = idsSchema.parse(change.before.value),
      after = idsSchema.parse(change.after.value);
    const stable = stableIds(before, after);
    const encode = (ids: string[]) => ({
      exists: true,
      value: {
        digest: digest(ids),
        placements: ids.flatMap((id, index) =>
          stable.has(id) ? [] : [{ id, previous: ids[index - 1] ?? null }],
        ),
      },
    });
    return { ...change, before: encode(before), after: encode(after) };
  });
}

export function expandCanvasPatch(patch: DocumentPatch, document: DesignDocument): DocumentPatch {
  return patch.map((change) => {
    if (
      change.collection === "document" ||
      change.id ||
      change.path[0] !== "$order" ||
      Array.isArray(change.before.value)
    )
      return change;
    const before = orderSchema.parse(change.before.value),
      after = orderSchema.parse(change.after.value);
    const current = document[change.collection].map((item) => item.id);
    if (digest(current) !== before.digest) throw new Error("Layer order changed elsewhere.");
    const removed = new Set(
      patch
        .filter(
          (item) =>
            item.collection === change.collection && !item.path.length && !item.after.exists,
        )
        .map((item) => item.id),
    );
    const desired = current.filter((id) => !removed.has(id));
    for (const item of patch)
      if (
        item.collection === change.collection &&
        !item.path.length &&
        item.after.exists &&
        item.id &&
        !desired.includes(item.id)
      )
        desired.push(item.id);
    for (const placement of after.placements) {
      const index = desired.indexOf(placement.id);
      if (index < 0) throw new Error("Missing layer in undo order.");
      desired.splice(index, 1);
      const anchor = placement.previous === null ? -1 : desired.indexOf(placement.previous);
      if (placement.previous !== null && anchor < 0) throw new Error("Missing layer order anchor.");
      desired.splice(anchor + 1, 0, placement.id);
    }
    if (digest(desired) !== after.digest) throw new Error("Invalid undo layer order.");
    return {
      ...change,
      before: { exists: true, value: current },
      after: { exists: true, value: desired },
    };
  });
}
