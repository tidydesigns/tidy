export type CanvasGeometry = { x: number; y: number; width: number };
export type ThreadCanvasDock = {
  ids: string[];
  floatingId?: string;
  geometry: Record<string, CanvasGeometry>;
};

export function parseCanvasDock(raw: string | null): ThreadCanvasDock {
  const empty: ThreadCanvasDock = { ids: [], geometry: {} };
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || !("ids" in value) || !Array.isArray(value.ids))
      return empty;
    const ids = [...new Set(value.ids.filter((id): id is string => typeof id === "string"))];
    const floatingId =
      "floatingId" in value &&
      typeof value.floatingId === "string" &&
      ids.includes(value.floatingId)
        ? value.floatingId
        : undefined;
    const geometry: Record<string, CanvasGeometry> = Object.create(null);
    if ("geometry" in value && value.geometry && typeof value.geometry === "object") {
      for (const id of ids) {
        const item = (value.geometry as Record<string, unknown>)[id];
        if (!item || typeof item !== "object") continue;
        const candidate = item as CanvasGeometry;
        if (
          [candidate.x, candidate.y, candidate.width].every(Number.isFinite) &&
          candidate.width > 0
        )
          geometry[id] = { x: candidate.x, y: candidate.y, width: candidate.width };
      }
    }
    return { ids, floatingId, geometry };
  } catch {
    return empty;
  }
}

/** Introduce the first canvas once. Later discoveries never steal the active window. */
export function discoverCanvases(state: ThreadCanvasDock, ids: string[]): ThreadCanvasDock {
  const added = ids.filter((id) => !state.ids.includes(id));
  if (!added.length) return state;
  return {
    ...state,
    ids: [...state.ids, ...new Set(added)],
    floatingId: state.ids.length ? state.floatingId : added[0],
  };
}
