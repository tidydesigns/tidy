import { useCallback, useState, useSyncExternalStore, type SetStateAction } from "react";
import { CloudReferenceImports } from "./cloud-reference";
import type { Draft } from "./machine-context";

type Drafts = Record<string, Draft>;
const empty: Drafts = {};

export class DraftStore {
  readonly references = new CloudReferenceImports();
  private values = new Map<string, Drafts>();
  private listeners = new Map<string, Set<() => void>>();

  get(machineId: string): Drafts {
    return this.values.get(machineId) ?? empty;
  }

  update(machineId: string, action: SetStateAction<Drafts>) {
    const previous = this.get(machineId);
    const next = typeof action === "function" ? action(previous) : action;
    if (next === previous) return;
    this.values.set(machineId, next);
    for (const listener of this.listeners.get(machineId) ?? []) listener();
  }

  subscribe(machineId: string, listener: () => void) {
    let listeners = this.listeners.get(machineId);
    if (!listeners) this.listeners.set(machineId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(machineId);
    };
  }
}

export function useDraftStore(cache: DraftStore | undefined, machineId: string) {
  const [fallback] = useState(() => new DraftStore());
  const store = cache ?? fallback;
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(machineId, listener),
    [store, machineId],
  );
  const snapshot = useCallback(() => store.get(machineId), [store, machineId]);
  const drafts = useSyncExternalStore(subscribe, snapshot);
  const setDrafts = useCallback(
    (action: SetStateAction<Drafts>) => store.update(machineId, action),
    [store, machineId],
  );
  return { drafts, setDrafts, store };
}
