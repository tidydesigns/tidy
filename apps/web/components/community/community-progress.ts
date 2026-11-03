type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const threshold = 5;

export function communityKeys(userId: string) {
  return {
    designs: `tidy:community:${userId}:designs`,
    dismissed: `tidy:community:${userId}:dismissed`,
  };
}

function designs(storage: Storage, key: string): string[] {
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
    return !storage.getItem(keys.dismissed) && designs(storage, keys.designs).length >= threshold;
  } catch {
    return false;
  }
}

/** Keep only enough local progress to qualify; dismissal has its own permanent key. */
export function recordCommunityDesign(storage: Storage, userId: string, designId: string) {
  try {
    const keys = communityKeys(userId);
    if (!designId || storage.getItem(keys.dismissed)) return;
    const opened = designs(storage, keys.designs);
    if (opened.length >= threshold || opened.includes(designId)) return;
    storage.setItem(keys.designs, JSON.stringify([...opened, designId]));
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
