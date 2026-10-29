export type OptimisticName = { name: string; operationId: string };

/** Once the server owns a created row, the local copy must never resurrect it. */
export function retireAddedItems<T extends { id: string }>(added: T[], server: { id: string }[]) {
  if (!added.length) return added;
  const ids = new Set(server.map((item) => item.id));
  const next = added.filter((item) => !ids.has(item.id));
  return next.length === added.length ? added : next;
}

/** Acknowledged names must stop masking later renames by other editors. */
export function retireNames(
  names: Record<string, OptimisticName>,
  server: { id: string; name: string }[],
) {
  if (!Object.keys(names).length) return names;
  let next = names;
  for (const item of server) {
    if (names[item.id]?.name !== item.name) continue;
    if (next === names) next = { ...names };
    delete next[item.id];
  }
  return next;
}

export function rollbackName(
  names: Record<string, OptimisticName>,
  id: string,
  operationId: string,
) {
  if (names[id]?.operationId !== operationId) return names;
  const next = { ...names };
  delete next[id];
  return next;
}
