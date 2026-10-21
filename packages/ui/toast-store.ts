export type ToastNotice = {
  id: number;
  message: string;
  tone: "error" | "success";
  onDismiss?: () => void;
  owner?: object;
};
let nextId = 0;
let notices: readonly ToastNotice[] = [];
const listeners = new Set<() => void>();
const empty: readonly ToastNotice[] = [];
export const toastSnapshot = () => notices;
export const emptyToastSnapshot = () => empty;
export function subscribeToasts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish(next: readonly ToastNotice[]) {
  notices = next;
  for (const listener of listeners) listener();
}
export function dismissToast(id: number, notifyOwner = false) {
  const notice = notices.find((notice) => notice.id === id);
  publish(notices.filter((notice) => notice.id !== id));
  if (notifyOwner) notice?.onDismiss?.();
}
export function clearToasts() {
  publish([]);
}
export function showToast(
  message: string,
  tone: ToastNotice["tone"] = "error",
  onDismiss?: () => void,
  owner?: object,
) {
  const existing = notices.find(
    (notice) => notice.message === message && notice.tone === tone && notice.owner === owner,
  );
  if (existing) return existing.id;
  const id = ++nextId;
  publish([...notices, { id, message, tone, onDismiss, owner }]);
  return id;
}
