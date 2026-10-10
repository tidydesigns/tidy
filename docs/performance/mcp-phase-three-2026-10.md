# MCP performance: phase three

Measured locally on October 10, 2026, against phase two (`5fb2721`). This pass keeps the same API and document storage architecture. The new branch carries both earlier passes on the latest main; none of these measurements represent a deployment.

## Completed user workflows

Two fresh-process runs per revision, 60 samples per scenario after five warmups, on the same Apple M5 / Bun 1.3.14 / PostgreSQL 17.11 setup. Each call uses the real authenticated MCP HTTP route and a disposable database. The multi-layer outcomes include a readback verifying every edited value and the resulting revision. Both revisions already use the phase-two batch API and compact acknowledgments.

The independent repeat:

| Outcome                                  | Phase two median | Phase three median | p95 before → after |         Reduction |
| ---------------------------------------- | ---------------: | -----------------: | -----------------: | ----------------: |
| Edit 20 layers and verify / 5,000 nodes  |         54.76 ms |           46.12 ms |   58.12 → 48.15 ms |               16% |
| Edit 250 layers and verify / 5,000 nodes |        142.06 ms |           51.08 ms |  158.26 → 54.48 ms | 64% (2.8× faster) |
| Edit master / 1,500 linked nodes         |         85.00 ms |           58.58 ms |   89.50 → 64.70 ms |               31% |

The first run gave 52.03 → 45.81 ms, 138.92 → 50.39 ms, and 83.33 → 57.77 ms respectively. Its discovery timings may overlap the end of the separate baseline kernel process, so the entirely separate repeat is the headline comparison. The outcome improvements repeat; these samples are not a production SLA or a statistical equivalence proof.

Raw results: [first baseline](mcp-phase-three-2026-10/before-final.json), [first optimized](mcp-phase-three-2026-10/after-final.json), [repeat baseline](mcp-phase-three-2026-10/before-repeat.json), [repeat optimized](mcp-phase-three-2026-10/after-repeat.json).

## What changed and why

### Transaction-local edit indexes

Previously each edit rebuilt the full node map, component-copy index and result array, then scanned the document to decide whether resize constraints were needed. A 250-edit batch repeated this work 250 times even when only names/colors changed.

One edit session now owns node and component indexes for the entire ordered batch. Each edit immediately updates affected nodes and overrides. Locks and token values are resolved from the current session; interaction/mask references reuse topology indexes. Only edits that actually change an affected node's inner dimensions invoke the complete resize-constraint pass. Resize effects settle before the next edit. No input document is mutated, and no index is reused across revisions or requests.

Let **N** be document nodes, **K** requested edits, **A** the sum of propagated copies across those edits, and **H** maximum ancestor depth. For ordinary property batches, preparation changes from **O(K × N + A)** to **O(N + K × H + A)**, plus patch/token processing. With bounded ancestry it is **O(N + K + A)**. K independent size changes can still require **O(K × N)** constraint work; arbitrary structural reconciliation retains phase two's limits. Final full validation and import-change tracking remain enabled.

At 5,000 nodes, 20-sample isolated kernel measurements after five warmups:

| Computation                               | Phase two median | Phase three median |
| ----------------------------------------- | ---------------: | -----------------: |
| Prepare 20 independent edits              |         6.284 ms |           0.166 ms |
| Prepare 250 independent edits             |        80.943 ms |           0.323 ms |
| Prepare, reconcile and validate 250 edits |       104.423 ms |          14.802 ms |
| Complete linked-component edit            |        35.147 ms |          34.782 ms |

These exclude HTTP and database work. The large preparation-only ratio is not an end-to-end speedup. [Kernel baseline](mcp-phase-three-2026-10/kernel-before.json), [optimized](mcp-phase-three-2026-10/kernel-after.json).

### Database collaboration events

Query profiling located about **61 of 82 ms** of the linked-component workflow inside the document UPDATE. The collaboration trigger traversed unchanged fields recursively and executed an individual SQL insert/upsert per changed conflict path.

The final trigger processes changed entities together with a recursive SQL work table, visits changed branches, and inserts/upserts the resulting paths in one statement. It retains the durable document event and sequence even for no-op updates. Arrays/scalars, missing values, JSON null, whole entity additions/deletions, nested objects and document metadata keep their existing conflict-path semantics. The `commentPages` exclusion remains unchanged. No event/history trigger is disabled or bypassed.

This reduces SQL executor overhead, not the number of conflict records required. It still reads/diffs the whole JSONB document and updates every changed path. Cost depends on JSON size, the node join plan, visited object keys and changed-path index writes; no universal linear bound is claimed for every database plan.

The experiment sequence was measured separately:

| Experiment                                   | Linked edit median | Document UPDATE mean elapsed |
| -------------------------------------------- | -----------------: | ---------------------------: |
| Phase two                                    |           82.02 ms |                     61.37 ms |
| Skip unchanged recursive calls + bulk insert |           60.59 ms |                     40.26 ms |
| Add shared edit indexes                      |           62.61 ms |                     41.33 ms |
| Process entities together in recursive SQL   |           58.34 ms |                     36.87 ms |

Intermediate runs are experiments, not combined estimates. [Profile baseline](mcp-phase-three-2026-10/baseline.json), [first trigger](mcp-phase-three-2026-10/trigger.json), [batch experiment](mcp-phase-three-2026-10/batch.json), [set-based trigger](mcp-phase-three-2026-10/setbased.json). Query profiling records SQL templates, counts and elapsed time without bound parameters. Timing includes client-side result decoding; it is not isolated database CPU.

### Two fewer database round trips per edit

A materialized authorization/file-lock query gates the document read/lock in one statement, retaining the existing file-before-document order and role/verified-user checks. The document update and file timestamp update share a data-modifying CTE. A single MCP edit therefore issues **23 instead of 25 SQL statements**; a batch plus verification issues **42 instead of 44**. It still takes two MCP calls, as in phase two.

Grant validation, separately committed quota admission, transaction/savepoint boundaries, asset authorization, revision checks, final publication checks and durable history are preserved. Authorization results are not cached across requests.

A separate 20-sample run injects a nominal 2 ms delay after each application database query (including callback queries). With that artificial delay, 20 edits + verification improve from 170.89 to 163.44 ms, 250 edits from 256.27 to 171.45 ms, and linked-component edits from 148.26 to 124.05 ms. Timer scheduling and queuing make this different from an exact network RTT; it is a sensitivity experiment, not a hosted latency forecast. [Delayed baseline](mcp-phase-three-2026-10/before-delay.json), [optimized](mcp-phase-three-2026-10/after-delay.json).

## Existing operations

The repeated 60-sample comparison includes ordinary calls:

| Operation               | Median before → after | p95 before → after |
| ----------------------- | --------------------: | -----------------: |
| Legacy discovery        |        2.53 → 2.33 ms |     4.23 → 3.69 ms |
| Modern discovery        |        2.01 → 2.29 ms |     3.30 → 3.54 ms |
| Small document read     |        3.04 → 3.14 ms |     4.26 → 4.54 ms |
| Five concurrent reads   |        7.37 → 6.75 ms |   15.54 → 10.40 ms |
| Full 5,000-node read    |      15.94 → 16.22 ms |   17.56 → 18.36 ms |
| Paged read / 50 nodes   |        3.29 → 3.31 ms |     4.40 → 4.30 ms |
| Full 5,000-node edit    |      49.17 → 48.95 ms |   52.27 → 52.14 ms |
| Compact 5,000-node edit |      42.22 → 41.69 ms |   45.54 → 42.74 ms |

The unchanged operations remain broadly similar; small measured increases are shown rather than treated as improvements. Discovery schemas, guidance and ordinary response payloads are unchanged. Runtime CPU measurements in the raw artifacts cover the whole benchmark process, including the client.

## Validation and browser workflow

Two short sustained-load comparisons used closed-loop workers, 80% small reads / 20% rename writes, five seconds at each concurrency, with the second comparison run in reverse revision order. Phase three completed **22,438 calls with zero rejected/error responses** across the two runs. This workload does not exercise the optimized batch/component edit paths. It does not show a general throughput improvement:

| Concurrency | First run RPS before → after | Reverse-order repeat RPS before → after | Repeat p95 before → after |
| ----------- | ---------------------------: | --------------------------------------: | ------------------------: |
| 1           |              332.14 → 323.04 |                         311.68 → 317.59 |            4.18 → 4.16 ms |
| 5           |              691.00 → 692.27 |                         677.91 → 659.53 |          11.11 → 11.35 ms |
| 20          |              655.06 → 631.58 |                         629.02 → 590.70 |          36.92 → 45.22 ms |
| 50          |              640.94 → 621.58 |                         592.18 → 637.46 |         105.51 → 90.74 ms |

The 20-client measurements are slower in both comparisons; other concurrency levels vary in direction. The affected production edit functions are not called by this read/rename workload, so these measurements do not establish causation, but they also do not prove non-regression at every concurrency. Treat deployment capacity/tail latency as an outstanding validation item, not a claimed gain. These are short local probes, not production forecasts or long-duration soaks. [First baseline](mcp-phase-three-2026-10/load-before.json), [first optimized](mcp-phase-three-2026-10/load-after.json), [repeat baseline](mcp-phase-three-2026-10/load-before-repeat.json), [repeat optimized](mcp-phase-three-2026-10/load-after-repeat.json).

Final checks passed: **152 MCP database tests (888 assertions)**, **738 unit tests** (662 database-gated tests skipped in that command), 21 multiplayer database tests, six version/history tests, three restricted-runtime tests, three release tests, type checking, lint/formatting, the standard production build and the OpenNext Worker build. The Worker environment finalizer excludes private environment values.

New coverage compares the trigger's exact changed-path records against the original SQL implementation for additions/deletions, nested objects, arrays, null/missing values, unusual keys, metadata, no-op updates and a 1,500-node update. Concurrent MCP batches at one revision commit exactly once while metering both calls. Batch tests cover settled resize constraints, ancestor locks/unlocks, token materialization, retained style/instance overrides, local interaction/mask remapping and immutable input snapshots. A deterministic differential run against phase two compared 500 batches / 10,000 ordered edits without a mismatch. The full suite retains authorization, cancellation, expiry, rollback, quota and legacy/modern protocol coverage.

The T3 browser repeated the repository's local website capture → authenticated MCP import → readback → self-contained rendered preview workflow, then composed and instantiated the repository's button example and applied a coordinated edit. The website capture has seven editable text layers/nine nodes and no capture warnings at a 1,536 × 960 CSS viewport. Visual comparison retained text wrapping, Instrument fonts, page background, logo placement and the orange bottom-only border. As in phase two, this fixture explicitly maps the source's Next font aliases, corrects the measured logo line box, and embeds checked-in font files; it does not claim automatic recovery of arbitrary website fonts or responsive behavior.

All three rendered button variants retained `Create design`, 12px corners, 10px/24px padding, the expected fills and no text overflow; the edit advanced one revision. [Browser call results](mcp-phase-three-2026-10/browser-workflow-calls.json), [rendered variant assertions](mcp-phase-three-2026-10/browser-variant-checks.json). This is functional/visual validation, not a new end-to-end latency claim: tests/builds ran during the smoke check. The disposable MCP server/database were stopped after verification; standalone HTML artifacts remain at `/tmp/tidy-mcp-phase3-workflow/preview-1.html` and `preview-2.html`.

## Rollout and reproduction

The application changes remain compatible with the previous database functions. Database-trigger gains require applying [20261010-document-event-performance.sql](../../migrations/20261010-document-event-performance.sql) after the multiplayer migration. It replaces one trigger function and performs no table/data migration. Both local initialization scripts and the multiplayer browser fixture include it. Only disposable local databases were migrated; production migration/deployment requires separate explicit approval.

```sh
# Run on each revision separately, using this revision's benchmark harness.
MCP_BENCHMARK_WORKFLOWS=1 MCP_BENCHMARK_BATCH=1 \
  MCP_BENCHMARK_BATCH_SIZES=20,250 MCP_BENCHMARK_COMPACT=1 \
  MCP_BENCHMARK_SAMPLES=60 MCP_BENCHMARK_OUTPUT=/tmp/mcp-phase-three.json \
  bun run bench:mcp

MCP_KERNEL_BATCH=1 MCP_BENCHMARK_OUTPUT=/tmp/mcp-kernel.json \
  bun apps/web/scripts/benchmark-design-edits.ts

# Optional query attribution; avoid comparing profiled and unprofiled timings.
MCP_BENCHMARK_PROFILE=1 MCP_BENCHMARK_WORKFLOWS=1 MCP_BENCHMARK_BATCH=1 \
  MCP_BENCHMARK_OUTPUT=/tmp/mcp-query-profile.json bun run bench:mcp
```

For phase two, use `5fb2721` and copy only `apps/web/lib/mcp/performance-benchmark.mjs` and `apps/web/scripts/benchmark-design-edits.ts` into that worktree. Keep its original database initialization/migrations. The kernel harness detects the absence of the shared batch API and uses the previous ordered single-edit implementation. Run benchmarks separately from tests/builds and other benchmark processes.
