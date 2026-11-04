import { useEffect, useSyncExternalStore } from "react";
import {
  defaultWorktreePreferences,
  type WorktreePreferences,
  type WorktreeStorage,
} from "../../../../shared/contracts/worktree-settings";
import { showToast } from "@tidy/ui/toast";

let current = { preferences: defaultWorktreePreferences, ready: false, error: "" };
let confirmed = defaultWorktreePreferences;
let loading: Promise<void> | undefined;
let writes = Promise.resolve();
let revision = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const currentWorktreePreferences = () => current;
export function loadWorktreePreferences() {
  if (loading) return loading;
  const api = window.tidy;
  const requestRevision = revision;
  loading = (async () => {
    try {
      if (!api?.worktreePreferences)
        throw new Error("Update this machine’s Tidy host to configure worktrees.");
      const preferences = await api.worktreePreferences();
      if (revision === requestRevision) {
        confirmed = preferences;
        current = { preferences, ready: true, error: "" };
      }
    } catch (error) {
      current = {
        ...current,
        error: error instanceof Error ? error.message : "Worktree preferences could not be loaded.",
      };
    } finally {
      loading = undefined;
      notify();
    }
  })();
  return loading;
}
export function useWorktreePreferences(active: boolean) {
  const state = useSyncExternalStore(subscribe, currentWorktreePreferences);
  useEffect(() => {
    if (active && !current.ready) void loadWorktreePreferences();
  }, [active]);
  return state;
}
export function changeWorktreePreferences(patch: Partial<WorktreePreferences>) {
  const preferences = { ...current.preferences, ...patch };
  const changeRevision = ++revision;
  current = { ...current, preferences, error: "" };
  notify();
  const next = writes
    .catch(() => {})
    .then(async () => {
      try {
        if (!window.tidy?.setWorktreePreferences)
          throw new Error("Worktree settings are unavailable on this machine.");
        confirmed = await window.tidy.setWorktreePreferences(preferences);
      } catch (error) {
        if (revision === changeRevision) {
          current = { preferences: confirmed, ready: true, error: "" };
          notify();
        }
        showToast(
          error instanceof Error ? error.message : "Worktree settings could not be remembered.",
        );
      }
    });
  writes = next;
}

let inventory: {
  entries: WorktreeStorage["entries"];
  ready: boolean;
  loading: boolean;
  error: string;
} = { entries: [], ready: false, loading: false, error: "" };
const inventoryListeners = new Set<() => void>();
export const currentWorktreeStorage = () => inventory;
const emitInventory = () => inventoryListeners.forEach((listener) => listener());
let scanning: Promise<void> | undefined;
const removing = new Set<string>();
export function refreshWorktreeStorage() {
  if (scanning) return scanning;
  inventory = { ...inventory, loading: true, error: "" };
  emitInventory();
  scanning = (async () => {
    try {
      if (!window.tidy?.worktreeStorage)
        throw new Error("Update this machine’s Tidy host to manage worktree storage.");
      const result = await window.tidy.worktreeStorage();
      inventory = {
        entries: result.entries.filter((entry) => !removing.has(entry.id)),
        ready: true,
        loading: false,
        error: "",
      };
    } catch (error) {
      inventory = {
        ...inventory,
        loading: false,
        error: error instanceof Error ? error.message : "Worktree storage could not be read.",
      };
    } finally {
      scanning = undefined;
      emitInventory();
    }
  })();
  return scanning;
}
export function useWorktreeStorage(active: boolean) {
  const state = useSyncExternalStore((listener) => {
    inventoryListeners.add(listener);
    return () => {
      inventoryListeners.delete(listener);
    };
  }, currentWorktreeStorage);
  useEffect(() => {
    if (active) void refreshWorktreeStorage();
  }, [active]);
  return state;
}
export async function removeStoredWorktree(entry: WorktreeStorage["entries"][number]) {
  removing.add(entry.id);
  inventory = { ...inventory, entries: inventory.entries.filter((item) => item.id !== entry.id) };
  emitInventory();
  try {
    if (!window.tidy?.removeWorktree)
      throw new Error("Worktree removal is unavailable on this machine.");
    await window.tidy.removeWorktree(entry.projectId, entry.id);
  } catch (error) {
    removing.delete(entry.id);
    if (!inventory.entries.some((item) => item.id === entry.id))
      inventory = { ...inventory, entries: [...inventory.entries, entry] };
    showToast(error instanceof Error ? error.message : "This worktree could not be removed.");
  } finally {
    emitInventory();
  }
}
