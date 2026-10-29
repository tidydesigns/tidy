type BrowserDraft = { id: string; status: "available" | "reserved" };
export type BrowserDraftCache = Map<string, BrowserDraft>;

export function browserDraftKey(scope: {
  machineId: string;
  projectId: string;
  executionProjectId: string;
}) {
  return `${scope.machineId}:${scope.projectId}:${scope.executionProjectId}`;
}

export function getBrowserDraft(cache: BrowserDraftCache, key: string) {
  const current = cache.get(key);
  if (current?.status === "available") return current.id;
  const next: BrowserDraft = { id: crypto.randomUUID(), status: "available" };
  cache.set(key, next);
  return next.id;
}

export function reserveBrowserDraft(cache: BrowserDraftCache, key: string, id: string) {
  const current = cache.get(key);
  if (current?.id !== id || current.status !== "available") return;
  current.status = "reserved";
  return () => {
    if (cache.get(key) === current) current.status = "available";
  };
}
