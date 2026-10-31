import { z } from "zod";

export const defaultAccessSchema = z.enum(["default", "provider-auto", "auto"]);
export type DefaultAccess = z.infer<typeof defaultAccessSchema>;
const storageKey = "tidy:default-access";
const listeners = new Set<() => void>();
let cached: DefaultAccess | undefined;
function read(): DefaultAccess {
  try {
    return defaultAccessSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? '"default"'));
  } catch {
    return "default";
  }
}
export function currentDefaultAccess() {
  return (cached ??= read());
}
export function subscribeDefaultAccess(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function selectDefaultAccess(value: DefaultAccess) {
  cached = defaultAccessSchema.parse(value);
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
