# Better Auth runtime patch

`@better-auth/core@1.7.7` uses a static `node:async_hooks` import in its server
entry point. Node and Cloudflare Workers with `nodejs_compat` support this
module. The separate browser/edge implementation is unchanged.

The upstream implementation caches a dynamic-import promise across requests.
On Workers, cancellation of the request driving that import can leave the
promise pending for later requests in the same isolate. Recreating the auth
instance does not reset this dependency-level state. See
[Better Auth issue #10315](https://github.com/better-auth/better-auth/issues/10315).

`bun run test:auth-worker` includes a workerd regression that injects a pending
dynamic runtime import and exercises session reads through both auth entry
points, password verification and session cookies, concurrent endpoint,
request-state and adapter context isolation, and Google/GitHub authorization state.
It fails with the original dependency and passes with this patch. This models
the pending-import failure deterministically; it does not depend on the timing
of a real client disconnect.

When upgrading Better Auth, remove this patch only after the upstream server
implementation no longer caches a pending runtime import and the regression
still passes.
