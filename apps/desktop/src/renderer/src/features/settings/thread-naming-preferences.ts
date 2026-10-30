import {
  defaultThreadNaming,
  threadNamingSchema,
  type ThreadNaming,
} from "../../../../shared/contracts/thread-naming";

const storageKey = "tidy:thread-naming";
const listeners = new Set<() => void>();
let cached: ThreadNaming | undefined;
function read() {
  try {
    return threadNamingSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "{}"));
  } catch {
    return defaultThreadNaming;
  }
}
export function currentThreadNaming() {
  return (cached ??= read());
}
export function subscribeThreadNaming(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function selectThreadNaming(value: ThreadNaming) {
  cached = threadNamingSchema.parse(value);
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
