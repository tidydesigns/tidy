import { z } from "zod";

const geometrySchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive().optional(),
});
export type CanvasGeometry = z.infer<typeof geometrySchema>;
export type ThreadCanvasDock = {
  ids: string[];
  openIds: string[];
  geometry: Record<string, CanvasGeometry>;
  revealedId?: string;
};

export function parseCanvasDock(raw: string | null): ThreadCanvasDock {
  const empty: ThreadCanvasDock = { ids: [], openIds: [], geometry: {} };
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
    const openIds =
      "openIds" in value && Array.isArray(value.openIds)
        ? [
            ...new Set(
              value.openIds.filter(
                (id): id is string => typeof id === "string" && ids.includes(id),
              ),
            ),
          ]
        : floatingId
          ? [floatingId]
          : [];
    const geometry: Record<string, CanvasGeometry> = Object.create(null);
    if ("geometry" in value && value.geometry && typeof value.geometry === "object") {
      for (const [id, item] of Object.entries(value.geometry)) {
        if (!ids.includes(id)) continue;
        const candidate = geometrySchema.safeParse(item);
        if (candidate.success) geometry[id] = candidate.data;
      }
    }
    const revealedId =
      "revealedId" in value && typeof value.revealedId === "string" ? value.revealedId : undefined;
    return { ids, openIds, geometry, ...(revealedId ? { revealedId } : {}) };
  } catch {
    return empty;
  }
}

export function discoverCanvases(state: ThreadCanvasDock, ids: string[]): ThreadCanvasDock {
  const added = ids.filter((id) => !state.ids.includes(id));
  if (!added.length) return state;
  return {
    ...state,
    ids: [...state.ids, ...new Set(added)],
    openIds: state.ids.length ? state.openIds : [added[0]],
  };
}

export function toggleCanvas(state: ThreadCanvasDock, id: string): ThreadCanvasDock {
  if (!state.ids.includes(id)) return state;
  return {
    ...state,
    openIds: state.openIds.includes(id)
      ? state.openIds.filter((value) => value !== id)
      : [...state.openIds, id],
  };
}

/** Remember consumption with the thread's dock state so navigation cannot replay a reveal. */
export function revealCanvas(
  state: ThreadCanvasDock,
  reveal: { id: string; designId: string },
): ThreadCanvasDock {
  if (state.revealedId === reveal.id) return state;
  const next = discoverCanvases(state, [reveal.designId]);
  return {
    ...next,
    revealedId: reveal.id,
    openIds: [...next.openIds.filter((id) => id !== reveal.designId), reveal.designId],
  };
}
