export type ToastAction = { label: string; onClick: () => void; disabled?: boolean };

export type ToastNotice = {
  id: number;
  message: string;
  tone: "error" | "success" | "info";
  onDismiss?: () => void;
  owner?: object;
  action?: ToastAction;
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
  if (!notice) return;
  publish(notices.filter((notice) => notice.id !== id));
  if (notifyOwner) notice.onDismiss?.();
}
export function clearToasts() {
  if (notices.length) publish([]);
}
export function showToast(
  message: string,
  tone: ToastNotice["tone"] = "error",
  onDismiss?: () => void,
  owner?: object,
  action?: ToastAction,
) {
  const existing = notices.find(
    (notice) => notice.message === message && notice.tone === tone && notice.owner === owner,
  );
  if (existing) return existing.id;
  const id = ++nextId;
  publish([...notices, { id, message, tone, onDismiss, owner, action }]);
  return id;
}

/** Keep an actionable notice in place as its message and progress change. */
export function updateToast(id: number, content: Omit<ToastNotice, "id" | "owner">) {
  const existing = notices.find((notice) => notice.id === id);
  if (!existing) return false;
  publish(
    notices.map((notice) =>
      notice === existing ? { id, owner: existing.owner, ...content } : notice,
    ),
  );
  return true;
}
