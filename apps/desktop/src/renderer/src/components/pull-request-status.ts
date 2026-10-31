import type { DesktopAPI } from "../../../shared/contracts/desktop";
import type { PullRequestState } from "../../../shared/contracts/pull-request";

type StatusAPI = Pick<DesktopAPI, "pullRequestState">;

export class PullRequestStatus {
  private snapshot: { state: PullRequestState | null; checking: boolean } = {
    state: null,
    checking: false,
  };
  private listeners = new Set<() => void>();
  private expires = 0;

  constructor(
    private input: { api: StatusAPI; projectId: string; url: string; now?: () => number },
  ) {}

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
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  async refresh() {
    const { api, projectId, url, now = Date.now } = this.input;
    if (!api.pullRequestState || this.snapshot.checking || now() < this.expires) return;
    this.publish({ ...this.snapshot, checking: true });
    let state: PullRequestState | null = null;
    try {
      state = await api.pullRequestState(projectId, url);
    } catch {
      state = null;
    }
    this.expires = now() + (state === null ? 15_000 : 60_000);
    this.publish({ state: state ?? this.snapshot.state, checking: false });
  }
}

const statuses = new WeakMap<StatusAPI, Map<string, PullRequestStatus>>();

export function pullRequestStatus(input: { api: StatusAPI; projectId: string; url: string }) {
  let cache = statuses.get(input.api);
  if (!cache) {
    cache = new Map();
    statuses.set(input.api, cache);
  }
  const key = `${input.projectId}:${input.url}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const status = new PullRequestStatus(input);
  if (cache.size >= 256) {
    const unused = [...cache].find(([, entry]) => !entry.subscribed);
    if (!unused) return status;
    cache.delete(unused[0]);
  }
  cache.set(key, status);
  return status;
}
