# Contributing

Tidy is licensed under the [Apache License 2.0](LICENSE). Contributions are
submitted under the same license. Bundled third-party licenses apply independently.

Use Bun 1.3.14 and PostgreSQL 17. Follow [local setup](README.md#local-development).
Use your own development OAuth applications, mail sender and analytics project.
Never use the maintainers' production accounts for fixtures or reproduction.

Before opening a pull request, run:

```sh
bun install --frozen-lockfile
bun typecheck
bun lint
bun test
bun run test:release
bun run audit:dependencies
bun run build:worker
```

Changes to authorization, billing, database or realtime behavior also require the
relevant disposable database suites listed in `package.json`. The default test
command skips database fixtures without their guarded environment; a skip is not
validation of those paths. Add regressions for observable permission boundaries,
including foreign IDs, exact roles, stale grants and concurrent revocation.

Keep credentials and deployment configuration out of commits. SQL belongs in
`migrations/`. Describe rollout order and backward compatibility when changing a
schema; stage incompatible changes across releases where possible. Application
services enforce authorization, even when a caller already checked a page or
route. Reuse existing custom UI components and preserve immediate interactions.

Public CI runs with a read-only token and synthetic fixtures. It does not deploy.
Follow [SECURITY.md](SECURITY.md) for private vulnerability reports.
