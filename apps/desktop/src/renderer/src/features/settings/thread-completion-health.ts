const failures = new Map<object, Map<string, string>>();
const listeners = new Set<() => void>();
const retries = new Set<() => void>();
let snapshot: string[] = [];

function publish() {
  const next = [
    ...new Set([...failures.values()].flatMap((entries) => [...entries.values()])),
  ].sort();
  if (next.length === snapshot.length && next.every((name, index) => name === snapshot[index]))
    return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function completionHealth() {
  return snapshot;
}
export function subscribeCompletionHealth(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function reportCompletionHealth(
  owner: object,
  projectId: string,
  name: string,
  failed: boolean,
) {
  let entries = failures.get(owner);
  if (failed) {
    if (!entries) failures.set(owner, (entries = new Map()));
    entries.set(projectId, name);
  } else entries?.delete(projectId);
  if (entries?.size === 0) failures.delete(owner);
  publish();
}
export function clearCompletionHealth(owner: object) {
  failures.delete(owner);
  publish();
}
export function subscribeCompletionRetry(check: () => void) {
  retries.add(check);
  return () => {
    retries.delete(check);
  };
}
export function retryCompletionChecks() {
  for (const check of retries) check();
}
