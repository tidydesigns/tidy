import type { DesktopAPI, HarnessId } from "../../../../shared/contracts/desktop";
import type { HarnessUsage } from "../../../../shared/contracts/harness-usage";

export type UsageSnapshot = { value?: HarnessUsage; loading: boolean; error?: string };
/** In-memory and machine-scoped. Account information is never placed in browser storage. */
export class UsageCache {
  private snapshot: UsageSnapshot;
  private pending?: Promise<void>;
  private checkedAt = 0;
  private version = 0;
  private invalidatedAt = 0;
  private listeners = new Set<() => void>();
  constructor(
    private load: () => Promise<HarnessUsage>,
    initial?: HarnessUsage,
  ) {
    this.snapshot = { value: initial, loading: false };
    if (initial) this.checkedAt = Math.min(Date.now(), Date.parse(initial.updatedAt));
  }
  read = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: UsageSnapshot) {
    this.snapshot = value;
    for (const listener of this.listeners) listener();
  }
  clear() {
    this.version++;
    this.invalidatedAt = Date.now();
    this.pending = undefined;
    this.checkedAt = 0;
    this.publish({ loading: false });
  }
  seed(value?: HarnessUsage) {
    if (
      !value ||
      Date.parse(value.updatedAt) <= this.invalidatedAt ||
      this.pending ||
      (this.snapshot.value &&
        Date.parse(this.snapshot.value.updatedAt) >= Date.parse(value.updatedAt))
    )
      return;
    this.checkedAt = Math.min(Date.now(), Date.parse(value.updatedAt));
    this.publish({ value, loading: false });
  }
  refresh = (force = false): Promise<void> => {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.checkedAt < 60_000) return Promise.resolve();
    const version = this.version;
    this.publish({ ...this.snapshot, loading: true, error: undefined });
    this.pending = Promise.resolve()
      .then(this.load)
      .then(
        (value) => {
          if (version !== this.version) return;
          this.checkedAt = Date.now();
          this.publish({ value, loading: false });
        },
        () => {
          if (version !== this.version) return;
          this.checkedAt = Date.now();
          this.publish({
            ...this.snapshot,
            loading: false,
            error: this.snapshot.value
              ? "Couldn't refresh usage. Showing last-known details."
              : "Couldn't load account usage. Try again or check your provider account.",
          });
        },
      )
      .finally(() => {
        if (version === this.version) this.pending = undefined;
      });
    return this.pending;
  };
}
const machines = new WeakMap<DesktopAPI, Map<string, UsageCache>>();
export function usageCache(
  api: DesktopAPI,
  projectId: string,
  harness: HarnessId,
  initial?: HarnessUsage,
) {
  let machine = machines.get(api);
  if (!machine) machines.set(api, (machine = new Map()));
  const key = `${projectId}:${harness}`;
  let cache = machine.get(key);
  if (!cache) {
    cache = new UsageCache(() => api.harnessUsage!(projectId, harness, true), initial);
    machine.set(key, cache);
    if (machine.size > 64) machine.delete(machine.keys().next().value!);
  }
  return cache;
}
