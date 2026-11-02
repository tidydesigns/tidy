import {
  defaultThreadCompletion,
  threadCompletionSchema,
  type ThreadCompletion,
} from "../../../../shared/contracts/thread-completion";

const storageKey = "tidy:thread-completion";
const listeners = new Set<() => void>();
let cached: ThreadCompletion | undefined;
function read() {
  try {
    return threadCompletionSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "{}"));
  } catch {
    return defaultThreadCompletion;
  }
}
export function currentThreadCompletion() {
  return (cached ??= read());
}
export function subscribeThreadCompletion(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function selectThreadCompletion(value: ThreadCompletion) {
  cached = threadCompletionSchema.parse(value);
  for (const listener of listeners) listener();
  try {
    localStorage.setItem(storageKey, JSON.stringify(cached));
    return true;
  } catch {
    return false;
  }
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    cached = read();
    for (const listener of listeners) listener();
  });
