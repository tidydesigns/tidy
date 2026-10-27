import type { DesignSummary, LocalDesign } from "../../../../../shared/contracts/desktop";

type Entry = { stamp: string; value: LocalDesign };
type Request = { id: string; promise: Promise<LocalDesign>; replace(value: LocalDesign): void };

/** Share reads, bound asset-heavy retention, and keep queued I/O out of the interaction path. */
export class DesignPreviewCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Request>();
  private listeners = new Set<() => void>();
  private snapshot: Readonly<Record<string, LocalDesign>> = {};
  private queue: (() => void)[] = [];
  private running = 0;

  constructor(
    private read: (id: string) => Promise<LocalDesign>,
    private capacity = 8,
    private concurrency = 2,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;

  private retain(id: string, entry: Entry) {
    this.entries.delete(id);
    this.entries.set(id, entry);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.snapshot = Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.value]));
    this.listeners.forEach((listener) => listener());
  }

  private schedule(read: () => Promise<LocalDesign>) {
    return new Promise<LocalDesign>((resolve, reject) => {
      const run = () => {
        this.running++;
        void Promise.resolve()
          .then(read)
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.queue.shift()?.();
          });
      };
      if (this.running < this.concurrency) run();
      else this.queue.push(run);
    });
  }

  load = (summary: DesignSummary): Promise<LocalDesign> => {
    const saved = this.entries.get(summary.id);
    if (saved?.stamp === summary.updatedAt) {
      this.entries.delete(summary.id);
      this.entries.set(summary.id, saved);
      return Promise.resolve(saved.value);
    }
    const key = `${summary.id}:${summary.updatedAt}`;
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    let replacement: LocalDesign | undefined;
    const promise = this.schedule(() => this.read(summary.id))
      .then((value) => {
        const current = this.entries.get(summary.id);
        const chosen =
          replacement ??
          (current && current !== saved && current.value.updatedAt >= value.updatedAt
            ? current.value
            : value);
        this.retain(summary.id, {
          stamp: chosen === value ? summary.updatedAt : chosen.updatedAt,
          value: chosen,
        });
        return chosen;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, {
      id: summary.id,
      promise,
      replace(value) {
        replacement = value;
      },
    });
    return promise;
  };

  update = (value: LocalDesign) => {
    for (const request of this.pending.values())
      if (request.id === value.id) request.replace(value);
    this.retain(value.id, { stamp: value.updatedAt, value });
  };
}
