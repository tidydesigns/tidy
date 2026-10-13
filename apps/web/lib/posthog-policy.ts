// Hard pause: existing environment variables must not resume collection.
// This covers server reporting, tracing, flag evaluation and source-map uploads.
// Keep disabled until a reviewed privacy/consent rollout explicitly replaces it.
export function posthogCollectionEnabled(): boolean {
  return false;
}
