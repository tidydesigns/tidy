import type { DesktopAPI } from "../../../shared/contracts/desktop";
import type { PullRequestState } from "../../../shared/contracts/pull-request";
import { pullRequestStateSchema } from "../../../shared/contracts/pull-request";
import { z } from "zod";

type StatusAPI = Pick<DesktopAPI, "pullRequestState">;

export class PullRequestStatus {
  private snapshot: { state: PullRequestState | null; checking: boolean };
  private listeners = new Set<() => void>();
  private expires = 0;
  private pending = false;

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
    this.snapshot = { state: input.initialState ?? null, checking: false };
  }

  get subscribed() {
    return this.listeners.size > 0;
  }

  read = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(snapshot: typeof this.snapshot) {
    if (snapshot.state === this.snapshot.state && snapshot.checking === this.snapshot.checking)
      return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  async refresh() {
    const { api, projectId, url, now = Date.now } = this.input;
    if (!api.pullRequestState || this.pending || now() < this.expires) return;
    this.pending = true;
    if (this.snapshot.state === null) this.publish({ ...this.snapshot, checking: true });
    let state: PullRequestState | null = null;
    try {
      state = await api.pullRequestState(projectId, url);
    } catch {
      state = null;
    }
    this.expires = now() + (state === null ? 15_000 : 60_000);
    this.pending = false;
    if (state !== null) this.input.onState?.(state);
    this.publish({ state: state ?? this.snapshot.state, checking: false });
  }
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
