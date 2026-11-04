type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const threshold = 3;

export function communityKeys(userId: string) {
  return {
    visits: `tidy:community:${userId}:visits`,
    dismissed: `tidy:community:${userId}:dismissed`,
  };
}

function visits(storage: Storage, key: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string" && !!id))].slice(
          0,
          threshold,
        )
      : [];
  } catch {
    return [];
  }
}

export function communityEligible(storage: Storage, userId: string) {
  try {
    const keys = communityKeys(userId);
    return !storage.getItem(keys.dismissed) && visits(storage, keys.visits).length >= threshold;
  } catch {
    return false;
  }
}

/** A mount has one visit ID so rerenders and Strict Mode cannot count it twice. */
export function recordCommunityVisit(storage: Storage, userId: string, visitId: string) {
  try {
    const keys = communityKeys(userId);
    if (!visitId || storage.getItem(keys.dismissed)) return;
    const recorded = visits(storage, keys.visits);
    if (recorded.length >= threshold || recorded.includes(visitId)) return;
    storage.setItem(keys.visits, JSON.stringify([...recorded, visitId]));
  } catch {
    // An optional invitation must never interfere with opening a design.
  }
}

export function dismissCommunity(storage: Storage, userId: string) {
  try {
    storage.setItem(communityKeys(userId).dismissed, "1");
  } catch {
    // The component still closes immediately when browser storage is unavailable.
  }
}
