/** Compare JSON values across validation and JSONB storage without relying on object key order. */
export function jsonValueKey(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
}

function jsonPrimitive(value: unknown) {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  return value;
}

function plain(value: object) {
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    typeof (value as { toJSON?: unknown }).toJSON !== "function"
  );
}

function hasToJSON(value: object) {
  return typeof (value as { toJSON?: unknown }).toJSON === "function";
}

/** JSON equality without sorting keys or allocating serialized copies of entire documents. */
export function equalJsonValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  a = jsonPrimitive(a);
  b = jsonPrimitive(b);
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    // Retain JSON's toJSON/boxed-value semantics for callers outside the document model.
    if (
      (a !== null && typeof a === "object") ||
      (b !== null && typeof b === "object") ||
      typeof a === "bigint" ||
      typeof b === "bigint"
    )
      return jsonValueKey(a) === jsonValueKey(b);
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (hasToJSON(a) || hasToJSON(b)) return jsonValueKey(a) === jsonValueKey(b);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++)
      if (!equalJsonValues(jsonPrimitive(a[i]) ?? null, jsonPrimitive(b[i]) ?? null)) return false;
    return true;
  }
  if (!plain(a) || !plain(b)) return jsonValueKey(a) === jsonValueKey(b);
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  for (const key of Object.keys(left)) {
    if (!equalJsonValues(left[key], Object.hasOwn(right, key) ? right[key] : undefined))
      return false;
  }
  for (const key of Object.keys(right))
    if (!Object.hasOwn(left, key) && !equalJsonValues(undefined, right[key])) return false;
  return true;
}
