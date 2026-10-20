# TypeScript / tsrs benchmarks

Measured on 2026-10-20, against source revision `13af0dc` with the tooling changes
on `chore/tsrs-typecheck-benchmarks`. Machine: Apple M5, 10 logical cores, 32 GiB RAM,
macOS arm64; Node 26.7.0, Bun 1.3.14, Turbo 2.11.5.

The baseline is each workspace's installed TypeScript **5.9.3**. The replacement
is **tsrs 0.18.0-ts7.1.0-dev.20260929**, targeting TypeScript
7.1.0-dev.20260930.4. This compares the repository's existing checker with the
experimental compiler introduced in [Cloudflare's announcement](https://blog.cloudflare.com/typescript-rust-port).
It does not reproduce that article's comparison against TypeScript 7.

## Full typecheck pipeline

Median wall time from five successful runs of each compiler, with Turbo caching
disabled. Both commands check all nine workspaces and include the same plugin
build, Next.js route generation and WXT preparation.

| Scenario                               | TypeScript 5.9.3 |    tsrs | Speedup |
| -------------------------------------- | ---------------: | ------: | ------: |
| Cold compiler cache                    |         11.063 s | 0.933 s |   11.9× |
| Warm compiler cache, no source changes |          7.918 s | 0.776 s |   10.2× |

Cold ranges: TypeScript 10.609–11.429 s; tsrs 0.905–1.033 s.
Warm ranges: TypeScript 7.755–8.494 s; tsrs 0.761–0.833 s.

## Compiler checks by project

Median wall time and median maximum resident set size from five successful runs
per compiler. Each command uses its existing project config with `--noEmit
--incremental false --pretty false`. Generated types are prepared before timing.
Memory is measured for each compiler process, in MiB (1,048,576 bytes).

| Project                | TypeScript time | tsrs time | Speedup | TypeScript peak RSS | tsrs peak RSS |
| ---------------------- | --------------: | --------: | ------: | ------------------: | ------------: |
| Desktop main / preload |         0.806 s |   0.064 s |   12.7× |           428.8 MiB |      91.3 MiB |
| Desktop renderer       |         2.670 s |   0.113 s |   23.7× |           615.4 MiB |     220.8 MiB |
| Extension              |         0.858 s |   0.063 s |   13.5× |           455.9 MiB |     102.0 MiB |
| GPT plugin             |         0.880 s |   0.067 s |   13.2× |           474.8 MiB |     125.7 MiB |
| Site                   |         0.438 s |   0.045 s |    9.7× |           317.9 MiB |      65.4 MiB |
| Web                    |         5.824 s |   0.254 s |   22.9× |          1600.3 MiB |     597.9 MiB |
| Design                 |         0.556 s |   0.051 s |   10.9× |           316.9 MiB |      72.0 MiB |
| Design renderer        |         0.700 s |   0.057 s |   12.3× |           308.0 MiB |      69.5 MiB |
| Editor                 |         2.595 s |   0.116 s |   22.4× |           591.3 MiB |     206.2 MiB |
| UI                     |         0.281 s |   0.040 s |    7.0× |           243.0 MiB |      42.5 MiB |

The web compiler uses approximately **63% less peak memory**. Pipeline memory is
omitted because per-process maximum RSS does not capture the combined memory of
concurrent Turbo tasks.

## Methodology and compatibility

- Each case has an untimed preparation or warmup and five measured samples.
  Compiler order alternates between samples. Tests and builds were run after the
  measurements to avoid competing with the benchmark.
- Both pipelines run with `--cache=local:,remote:` so Turbo never supplies cached
  task results. Cold runs remove workspace-root `.tsbuildinfo` files. Warm runs
  restore separate build-info snapshots for each compiler before timing, avoiding
  cache invalidation from switching TypeScript versions. Generated files and the
  operating system's filesystem cache remain available in both cases.
- Both tools use the same configs and their default worker settings. The design
  config explicitly includes its existing Node typings, required by a fixture
  importing `node:fs/promises`. Both the baseline and replacement measurements use
  that config.
- All 120 timed checks exited successfully without type diagnostics. A temporary
  invalid string assignment was also checked in each of the ten projects; both
  compilers reported TS2322 and exited with status 2. These probes were removed.
  This validates project coverage and basic error detection, not full compiler
  equivalence.
- tsrs remains experimental. Its pinned release provides macOS arm64 and Linux
  x64/arm64 binaries; Windows and Intel Mac users can run `bun run typecheck:tsc`.
  See [upstream compatibility notes](https://github.com/oxc-project/tsrs/blob/main/docs/COMPATIBILITY.md).
- `bun typecheck` now uses tsrs. The original checker remains available through
  `bun run typecheck:tsc`. TypeScript remains installed for editor integration and
  Next.js builds. These numbers measure typechecking, not application runtime or
  production build performance.

## Reproduce

From the repository root:

```sh
bun install --frozen-lockfile
bun run bench:typecheck
```

The harness writes every timing, exit code, compiler version and machine details
to `.artifacts/typecheck-benchmark/results.json`, alongside command logs and
per-process memory measurements. Change the sample count or output directory with:

```sh
BENCH_RUNS=5 BENCH_OUTPUT=.artifacts/typecheck-benchmark bun run bench:typecheck
```

Run it while no other builds or typechecks are active; it temporarily manages the
workspace-root compiler cache files and restores its saved snapshot on completion.

## Validation

- Frozen-lockfile install and both compilers' full typecheck pipelines passed.
- `bun lint` passed with one existing warning in the auth-context Worker fixture.
- `TMPDIR=/private/tmp bun test`: 1,319 passed, 744 skipped, zero failures. The
  default macOS temp path caused an unrelated `/var` versus `/private/var` path
  assertion failure; the canonical temp path resolves it without changing tests.
- `WXT_BELLA_URL=https://extension-build.invalid POSTHOG_UPLOAD_SOURCEMAPS=0 bun run build --env-mode=loose`
  passed all five build tasks. This uses the repository's CI extension origin and
  disables source-map uploads for local verification.
