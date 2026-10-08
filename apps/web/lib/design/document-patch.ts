import { reconcileComponentStructure } from "./component-structure";
import { z } from "zod";
import { replacePlainText } from "@bella/design/rich-text";
import { parseDesignDocument, type DesignDocument } from "./document";
import { importNoteKey, importNotes, type ImportNote } from "./import-notes";
import { equalJsonValues as equal, jsonValueKey } from "./json-value";

// IDs address entities; object paths address individual properties. Missing values
// have an explicit representation so JSON transport can express property removal.
const value = z.object({ exists: z.boolean(), value: z.json().optional() }).strict();
export const documentPatchSchema = z
  .array(
    z
      .object({
        collection: z.enum(["nodes", "pages", "document"]),
        id: z.string().min(1).max(120).optional(),
        path: z.array(z.string().min(1).max(120)).max(8),
        before: value,
        after: value,
      })
      .strict(),
  )
  .max(50000);
export type DocumentPatch = z.infer<typeof documentPatchSchema>;
type Value = DocumentPatch[number]["before"];
type ObjectValue = Record<string, unknown>;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function wrapped(value: unknown): Value {
  return value === undefined
    ? { exists: false }
    : { exists: true, value: JSON.parse(JSON.stringify(value)) };
}
function difference(
  before: unknown,
  after: unknown,
  path: string[],
  add: (path: string[], before: Value, after: Value) => void,
) {
  if (equal(before, after)) return;
  if (object(before) && object(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      difference(before[key], after[key], [...path, key], add);
  } else add(path, wrapped(before), wrapped(after));
}
export function diffDocument(before: DesignDocument, after: DesignDocument): DocumentPatch {
  const patch: DocumentPatch = [];
  for (const collection of ["nodes", "pages"] as const) {
    const old = new Map(before[collection].map((item) => [item.id, item]));
    const next = new Map(after[collection].map((item) => [item.id, item]));
    for (const id of new Set([...old.keys(), ...next.keys()]))
      difference(old.get(id), next.get(id), [], (path, a, b) =>
        patch.push({ collection, id, path, before: a, after: b }),
      );
    const oldOrder = before[collection].map((item) => item.id);
    const newOrder = after[collection].map((item) => item.id);
    if (!equal(oldOrder, newOrder))
      patch.push({
        collection,
        path: ["$order"],
        before: wrapped(oldOrder),
        after: wrapped(newOrder),
      });
  }
  const { nodes: _bn, pages: _bp, commentPages: _bc, ...beforeProperties } = before;
  const { nodes: _an, pages: _ap, commentPages: _ac, ...afterProperties } = after;
  void _bn;
  void _bp;
  void _bc;
  void _an;
  void _ap;
  void _ac;
  difference(beforeProperties, afterProperties, [], (path, a, b) =>
    patch.push({ collection: "document", path, before: a, after: b }),
  );
  return patch;
}
export function invertPatch(patch: DocumentPatch): DocumentPatch {
  return patch.map((change) => ({ ...change, before: change.after, after: change.before }));
}
function get(root: unknown, path: string[]): unknown {
  for (const key of path) {
    if (!object(root)) return undefined;
    root = root[key];
  }
  return root;
}
function set(root: ObjectValue, path: string[], next: Value) {
  for (const key of path.slice(0, -1)) {
    root[key] = object(root[key]) ? { ...root[key] } : {};
    root = root[key] as ObjectValue;
  }
  const key = path.at(-1)!;
  if (next.exists) root[key] = structuredClone(next.value);
  else delete root[key];
}
export function applyDocumentPatch(
  document: DesignDocument,
  input: DocumentPatch,
  conditional = false,
): DesignDocument {
  const patch = documentPatchSchema.parse(input);
  // Copy only edited paths while staging the transaction. The full schema parse
  // below still validates every entity and returns an independently owned result.
  const result: ObjectValue = {
    ...document,
    nodes: [...document.nodes],
    pages: [...document.pages],
  };
  const indexes = new Map<string, Map<string, number>>();
  for (const change of patch) {
    if (
      change.path.some((key) => forbidden.has(key)) ||
      (change.collection === "document" &&
        (!change.path.length ||
          ["nodes", "pages", "commentPages", "schemaVersion", "legacyConverted"].includes(
            change.path[0],
          )))
    )
      throw new Error("Invalid document patch.");
    if (change.collection === "document") {
      const current = wrapped(get(result, change.path));
      if (
        change.path[0] === "warnings" &&
        change.path.length === 1 &&
        Array.isArray(change.before.value) &&
        Array.isArray(change.after.value)
      ) {
        const normalize = (warnings: unknown[]) =>
          importNotes({ ...document, warnings: warnings as ImportNote[] });
        const before = new Map(
          normalize(change.before.value).map((note) => [importNoteKey(note), note]),
        );
        const after = new Map(
          normalize(change.after.value).map((note) => [importNoteKey(note), note]),
        );
        const notes = new Map(
          normalize(result.warnings as unknown[]).map((note) => [importNoteKey(note), note]),
        );
        for (const key of new Set([...before.keys(), ...after.keys()])) {
          if (equal(before.get(key), after.get(key))) continue;
          if (conditional && !equal(notes.get(key), before.get(key)))
            throw new Error("This import note changed elsewhere and cannot be undone.");
          if (!after.has(key)) notes.delete(key);
          // A late acknowledgement must not resurrect a note retired by reimport.
          else if (!before.has(key) || notes.has(key)) notes.set(key, after.get(key)!);
        }
        result.warnings = [...notes.values()];
      } else if (
        ["editedNodeIds", "deletedSourceKeys"].includes(change.path[0]) &&
        change.path.length === 1
      ) {
        const existing = (result[change.path[0]] ?? []) as unknown[];
        const before = Array.isArray(change.before.value) ? change.before.value : [];
        const after = Array.isArray(change.after.value) ? change.after.value : [];
        const beforeKeys = new Set(before.map(jsonValueKey));
        const afterKeys = new Set(after.map(jsonValueKey));
        const remove = new Set(
          before.filter((item) => !afterKeys.has(jsonValueKey(item))).map(jsonValueKey),
        );
        // An imported node can still have another user's manual edits after undo.
        // Keep its edit marker; deletion tombstones, however, must be reversible.
        const kept =
          change.path[0] === "editedNodeIds"
            ? existing
            : existing.filter((item) => !remove.has(jsonValueKey(item)));
        const added = after.filter((item) => !beforeKeys.has(jsonValueKey(item)));
        result[change.path[0]] = [
          ...new Map([...kept, ...added].map((item) => [jsonValueKey(item), item])).values(),
        ];
      } else {
        if (conditional && !equal(current, change.before))
          throw new Error("This edit changed elsewhere and cannot be undone.");
        set(result, change.path, change.after);
      }
      continue;
    }
    const items = result[change.collection] as ObjectValue[];
    if (!change.id && change.path.length === 1 && change.path[0] === "$order") {
      const desired = change.after.value as string[];
      if (
        !Array.isArray(desired) ||
        desired.some((id) => typeof id !== "string") ||
        new Set(desired).size !== desired.length
      )
        throw new Error("Invalid layer order.");
      if (
        conditional &&
        !equal(
          wrapped(
            document[change.collection]
              .map((item) => item.id)
              .filter((id) => (change.before.value as string[]).includes(id)),
          ),
          change.before,
        )
      )
        throw new Error("Layer order changed elsewhere.");
      // Preserve entities another editor created since this command's base.
      const rank = new Map(desired.map((id, index) => [id, index]));
      result[change.collection] = [...items].sort(
        (a, b) =>
          (rank.get(a.id as string) ?? desired.length) -
          (rank.get(b.id as string) ?? desired.length),
      );
      indexes.delete(change.collection);
      continue;
    }
    if (!change.id) throw new Error("Missing entity ID.");
    let byId = indexes.get(change.collection);
    if (!byId) {
      byId = new Map(items.map((item, index) => [item.id as string, index]));
      indexes.set(change.collection, byId);
    }
    const index = byId.get(change.id) ?? -1;
    const current = wrapped(get(items[index], change.path));
    // A stale client's derived master propagation must not overwrite a newer explicit override.
    if (!conditional && change.collection === "nodes" && change.path.length && index >= 0) {
      const node = items[index] as unknown as DesignDocument["nodes"][number];
      const path = change.path.join(".");
      if (node.instanceOverrides?.some((entry) => path === entry || path.startsWith(`${entry}.`))) {
        let sourceId = node.componentSourceId;
        const seen = new Set<string>();
        let inherited = false;
        while (sourceId && !seen.has(sourceId)) {
          seen.add(sourceId);
          if (
            patch.some(
              (item) =>
                item.collection === "nodes" &&
                item.id === sourceId &&
                equal(item.path, change.path) &&
                equal(item.after, change.after),
            )
          ) {
            inherited = true;
            break;
          }
          sourceId = document.nodes.find((item) => item.id === sourceId)?.componentSourceId;
        }
        if (inherited) continue;
      }
    }
    const overrideSet =
      change.collection === "nodes" &&
      change.path.length === 1 &&
      change.path[0] === "instanceOverrides";
    if (conditional && !overrideSet && !equal(current, change.before))
      throw new Error("This edit changed elsewhere and cannot be undone.");
    if (!change.path.length) {
      if (!change.after.exists) {
        if (index >= 0) {
          items.splice(index, 1);
          indexes.delete(change.collection);
        }
      } else if (index >= 0) {
        if (!equal(items[index], change.after.value)) throw new Error("Layer ID already exists.");
      } else {
        if (change.before.exists) throw new Error("This layer or page was deleted elsewhere.");
        if (!object(change.after.value) || change.after.value.id !== change.id)
          throw new Error("Invalid entity.");
        items.push(structuredClone(change.after.value));
        byId.set(change.id, items.length - 1);
      }
    } else {
      if (index < 0) throw new Error("This layer or page was deleted elsewhere.");
      if (change.path[0] === "id") throw new Error("Entity IDs cannot change.");
      items[index] = { ...items[index] };
      if (overrideSet) {
        const before = Array.isArray(change.before.value) ? (change.before.value as string[]) : [];
        const after = Array.isArray(change.after.value) ? (change.after.value as string[]) : [];
        const existing = (items[index].instanceOverrides as string[] | undefined) ?? [];
        const removed = before.filter((item) => !after.includes(item));
        items[index].instanceOverrides = [
          ...new Set([
            ...existing.filter((item) => !removed.includes(item)),
            ...after.filter((item) => !before.includes(item)),
          ]),
        ];
      } else set(items[index], change.path, change.after);
    }
  }
  const cropEdits = new Set(
    patch
      .filter(
        (p) =>
          p.collection === "nodes" &&
          ((p.path[0] === "style" &&
            (p.path[1] === "imageCrop" ||
              (p.path.length === 1 && object(p.after.value) && "imageCrop" in p.after.value))) ||
            (!p.path.length &&
              object(p.after.value) &&
              object(p.after.value.style) &&
              "imageCrop" in p.after.value.style)),
      )
      .map((p) => p.id),
  );
  const priorNodes = new Map(document.nodes.map((node) => [node.id, node]));
  result.nodes = (result.nodes as DesignDocument["nodes"]).map((node) => {
    const prior = priorNodes.get(node.id);
    if (!prior || prior.assetId === node.assetId) return node;
    return {
      ...node,
      vectorPath: node.vectorPath === prior.vectorPath ? undefined : node.vectorPath,
      style: cropEdits.has(node.id)
        ? node.style
        : { ...node.style, imageCrop: undefined, objectScale: 1 },
    };
  });
  const richEdits = new Set(
    patch.filter((p) => p.collection === "nodes" && p.path[0] === "richText").map((p) => p.id),
  );
  const textEdits = new Set(
    patch.filter((p) => p.collection === "nodes" && p.path[0] === "text").map((p) => p.id),
  );
  const previousNodes = new Map(document.nodes.map((node) => [node.id, node]));
  result.nodes = (result.nodes as DesignDocument["nodes"]).map((node) => {
    const previous = previousNodes.get(node.id);
    return previous?.richText && textEdits.has(node.id) && !richEdits.has(node.id)
      ? {
          ...node,
          ...replacePlainText(
            { text: previous.text ?? "", richText: previous.richText },
            node.text ?? "",
          ),
        }
      : node;
  });
  result.nodes = reconcileComponentStructure(
    document.nodes,
    result.nodes as DesignDocument["nodes"],
  );
  const liveIds = new Set((result.nodes as ObjectValue[]).map((node) => node.id));
  result.editedNodeIds = (result.editedNodeIds as string[]).filter((id) => liveIds.has(id));
  return parseDesignDocument(result);
}
