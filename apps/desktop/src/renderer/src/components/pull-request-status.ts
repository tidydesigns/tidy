import type { DesktopAPI } from "../../../shared/contracts/desktop";
import type { PullRequestState } from "../../../shared/contracts/pull-request";
import { pullRequestStateSchema, pullRequestURL } from "../../../shared/contracts/pull-request";
import { z } from "zod";

export type StatusAPI = Pick<DesktopAPI, "pullRequestState"> & Partial<Pick<DesktopAPI, "onEvent">>;

export class PullRequestStatus {
  private snapshot: { state: PullRequestState | null; checking: boolean };
  private listeners = new Set<() => void>();
  private expires = 0;
  private pending?: Promise<void>;
  private queued?: Promise<void>;
  private version = 0;
  private unsubscribe?: () => void;
  private readonly canonicalURL: string | null;

  constructor(
    private input: {
      api: StatusAPI;
      projectId: string;
      url: string;
      now?: () => number;
      initialState?: PullRequestState;
      onState?: (state: PullRequestState) => void;
    },
  ) {
    this.canonicalURL = pullRequestURL(input.url);
    this.snapshot = { state: input.initialState ?? null, checking: false };
  }

  get subscribed() {
    return this.listeners.size > 0;
  }

  read = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1)
      this.unsubscribe = this.input.api.onEvent?.((event) => {
        if (
          event.type === "pull-request-state" &&
          event.projectId === this.input.projectId &&
          event.url === this.canonicalURL
        ) {
          this.version++;
          this.accept(event.state);
        }
      });
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    };
  };

  private publish(snapshot: typeof this.snapshot) {
    if (snapshot.state === this.snapshot.state && snapshot.checking === this.snapshot.checking)
      return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private accept(state: PullRequestState) {
    // A merged PR cannot reopen; late responses must not turn its icon green again.
    if (this.snapshot.state === "merged" && state !== "merged") return;
    this.input.onState?.(state);
    this.publish({ state, checking: false });
  }

  refresh = (force = false): Promise<void> => {
    const { api, projectId, url, now = Date.now } = this.input;
    if (!api.pullRequestState) return Promise.resolve();
    if (this.snapshot.state === "merged") {
      this.input.onState?.("merged");
      return Promise.resolve();
    }
    if (this.pending) {
      if (!force) return Promise.resolve();
      return (this.queued ??= this.pending.then(() => {
        this.queued = undefined;
        return this.refresh(true);
      }));
    }
    if (!force && now() < this.expires) return Promise.resolve();
    const version = this.version;
    if (this.snapshot.state === null) this.publish({ ...this.snapshot, checking: true });
    this.pending = (async () => {
      let state: PullRequestState | null = null;
      try {
        state = await api.pullRequestState!(projectId, url, force);
      } catch {}
      this.expires = now() + (state === null ? 15_000 : 10_000);
      if (version === this.version && state !== null) this.accept(state);
      else this.publish({ ...this.snapshot, checking: false });
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  };
}

const statuses = new WeakMap<StatusAPI, Map<string, PullRequestStatus>>();
const storageKey = "tidy:pull-request-status";
const storedStatesSchema = z
  .array(z.tuple([z.string().max(8192), pullRequestStateSchema]))
  .max(256);
type StatusStorage = Pick<Storage, "getItem" | "setItem">;
const persisted = new WeakMap<StatusStorage, Map<string, PullRequestState>>();

function storedStates(storage?: StatusStorage) {
  if (!storage) return new Map<string, PullRequestState>();
  const cached = persisted.get(storage);
  if (cached) return cached;
  let states = new Map<string, PullRequestState>();
  try {
    states = new Map(storedStatesSchema.parse(JSON.parse(storage.getItem(storageKey) ?? "[]")));
  } catch {}
  persisted.set(storage, states);
  return states;
}

function persistentCache() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function pullRequestStatus(input: {
  api: StatusAPI;
  projectId: string;
  url: string;
  scope?: string;
  storage?: StatusStorage;
}) {
  input = { ...input, url: pullRequestURL(input.url) ?? input.url };
  let cache = statuses.get(input.api);
  if (!cache) {
    cache = new Map();
    statuses.set(input.api, cache);
  }
  const key = JSON.stringify([input.scope ?? "", input.projectId, input.url]);
  const existing = cache.get(key);
  if (existing) return existing;
  const storage = input.storage ?? persistentCache();
  const status = new PullRequestStatus({
    ...input,
    initialState: storedStates(storage).get(key),
    onState(state) {
      if (!storage) return;
      try {
        const entries = storedStates(storage);
        if (entries.get(key) === state) return;
        const next = new Map(entries);
        next.delete(key);
        next.set(key, state);
        while (next.size > 256) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        storage.setItem(storageKey, JSON.stringify([...next]));
        persisted.set(storage, next);
      } catch {}
    },
  });
  if (cache.size >= 256) {
    const unused = [...cache].find(([, entry]) => !entry.subscribed);
    if (!unused) return status;
    cache.delete(unused[0]);
  }
  cache.set(key, status);
  return status;
}
