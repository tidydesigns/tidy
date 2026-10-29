import type { AnalyticsAPI, AnalyticsState } from "@tidy/design/analytics";

type Snapshot = {
  value?: AnalyticsState;
  pending?: Promise<AnalyticsState>;
  revision: number;
};
// Share local consent metadata between diagnostics and settings, never persist it
// in renderer storage or reuse it for a different native API/session.
const snapshots = new WeakMap<AnalyticsAPI, Snapshot>();
function snapshot(api: AnalyticsAPI) {
  let entry = snapshots.get(api);
  if (!entry) {
    entry = { revision: 0 };
    snapshots.set(api, entry);
  }
  return entry;
}

export function cachedAnalyticsState(api?: AnalyticsAPI) {
  return api ? snapshot(api).value : undefined;
}

export function readAnalyticsState(api: AnalyticsAPI): Promise<AnalyticsState> {
  const entry = snapshot(api);
  if (entry.pending) return entry.pending;
  const revision = entry.revision;
  const request = api.state().then((value) => {
    if (entry.revision === revision) entry.value = value;
    return entry.value ?? value;
  });
  entry.pending = request;
  void request
    .finally(() => {
      if (entry.pending === request) entry.pending = undefined;
    })
    .catch(() => {});
  return request;
}

export function subscribeAnalyticsState(
  api: AnalyticsAPI,
  listener: (value: AnalyticsState) => void,
) {
  const entry = snapshot(api);
  return api.subscribe((value) => {
    entry.revision++;
    entry.value = value;
    listener(value);
  });
}
