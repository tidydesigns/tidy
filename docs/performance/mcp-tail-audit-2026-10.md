# MCP phase-three tail-latency audit — 11 October 2026

Conclusion: the original slower tail samples were real observations, but these local tests do not establish a phase-three-caused regression. Saturated tails remain variable and the median of the three uninstrumented phase-three saturation runs is worse. Sequential and fixed-demand tests do not show a consistent slowdown. Retain the saturation caveat; do not claim universal non-regression or production equivalence.

## Method

- Compare phase two `5fb2721` with phase three `9b890ac`, using the identical temporary harness in each worktree. Original files restored after the audit. These historical timings precede the PR rebase onto `af52ed8`; see [revision metadata](mcp-tail-audit-2026-10/metadata.json).
- Real authenticated HTTP MCP requests to a local Bun server, restricted database login, fresh disposable PostgreSQL cluster per run. Same workload: 80% small `get_document`, 20% `rename_file`, one workspace.
- Saturation: 20 continuously replenished in-flight requests, 5-second concurrent warmup, 30 seconds measured. Revision order A B B A A B. This is not a simulation of 20 connected users with pauses between calls.
- Fixed demand: 100 and 300 arrivals/sec for 20 seconds each after 3 seconds warmup. Two runs/revision/rate, reversed order for the repeat. Sequential caller: 15 seconds measured after 3 seconds warmup.
- Separate 10-second traced saturation samples attribute waits; do not combine their timings with the uninstrumented results.
- The first fixed-rate series allowed fractional early timer wakeups. Actual-launch latency is shown for both series. The corrected repeat waits until the intended arrival and additionally reports scheduled latency, including client scheduling delay. See metadata.json for harness hashes.
- Shared Apple M5 workstation, Bun 1.3.14, local PostgreSQL. An unrelated Next development server consumed roughly one CPU core; browser/system load also varied. Existing processes were left running. No other audit benchmark or test was run concurrently. These are not isolated-host or deployed-Worker measurements.

## Saturation results

| Run order | Revision    | Requests/sec | p50 ms | p95 ms | p99 ms |
| --------- | ----------- | -----------: | -----: | -----: | -----: |
| a1        | Phase two   |       481.33 |  37.72 |  61.63 |  96.61 |
| b1        | Phase three |       490.98 |  34.43 |  72.88 | 137.34 |
| b2        | Phase three |       547.03 |  33.19 |  58.56 | 105.65 |
| a2        | Phase two   |       553.45 |  34.22 |  48.33 |  65.37 |
| a3        | Phase two   |       552.27 |  34.22 |  50.08 |  66.60 |
| b3        | Phase three |       581.22 |  33.50 |  42.11 |  53.88 |

Medians across the three independent runs: throughput 552.27 → 547.03 requests/sec (-0.9%); p95 50.08 → 58.56 ms; p99 66.60 → 105.65 ms. These are medians of run percentiles, not pooled percentiles or confidence bounds.

Phase three b3 beats every baseline run for throughput, p95 and p99; b1 and b2 have large localized spikes. Five-second window statistics are preserved in the committed summary. Individual request records remain in the local audit directory. This does not justify deleting the worse runs or asserting that noise is the proven cause.

## Sequential and fixed-demand calls

All latency figures below are from actual HTTP call launch through response-body consumption.

| Scenario               | Phase two p50 / p95 / p99 ms | Phase three p50 / p95 / p99 ms |
| ---------------------- | ---------------------------: | -----------------------------: |
| One caller             |           2.98 / 4.37 / 6.17 |             2.93 / 3.97 / 4.59 |
| 100/sec first          |          3.90 / 6.37 / 12.17 |             3.59 / 5.48 / 9.02 |
| 100/sec reverse repeat |           3.54 / 5.53 / 9.49 |            3.60 / 5.77 / 15.13 |
| 300/sec first          |           2.96 / 4.71 / 6.17 |             2.98 / 4.75 / 5.92 |
| 300/sec reverse repeat |         3.15 / 11.02 / 72.28 |            3.11 / 6.98 / 41.04 |

Corrected fixed-rate repeat, latency measured from scheduled arrival (includes delayed client launch):

| Offered load | Phase two p95 / p99 ms | Phase three p95 / p99 ms |
| ------------ | ---------------------: | -----------------------: |
| 100/sec      |           6.35 / 10.31 |             6.74 / 16.20 |
| 300/sec      |          11.99 / 73.05 |             8.03 / 41.90 |

## Attribution

The measured read/rename workload does not invoke the optimized batch edit functions or the replaced document UPDATE trigger after fixture setup. The database pool, MCP quota/admission, grant-operation, activity, and file-management service files are byte-for-byte unchanged between revisions (empty unchanged-paths.diff). Query counts remain approximately 20/request in both versions. Code inspection reduces the likelihood of a direct regression in this workload, but cannot rule out indirect runtime effects.

Both use the unchanged local pool limit of five and workspace advisory locking. Separate instrumented runs show the following per-span means (nested spans overlap; do not sum this table):

| Span               | Phase two mean ms | Phase three mean ms |
| ------------------ | ----------------: | ------------------: |
| database.connect   |              3.54 |                3.33 |
| mcp.workspace_lock |              3.84 |                3.65 |
| mcp.admission      |             12.59 |               11.96 |
| mcp.execution      |              6.45 |                5.95 |

## User impact and limits

For the sequential caller and tested fixed-demand rates, the data do not support a noticeable slowdown caused by phase three. This is an inference from local MCP timings, not a user perception study; client-to-production networking and model generation were not measured.

At sustained saturation, extra tens of milliseconds in the slowest calls can matter to automation or latency budgets. The observed run-median p99 difference is about 39 ms. It does not apply to every call, and percentile differences should not be multiplied to predict a multi-call workflow. Keep saturation capacity/tail validation open until an isolated-host and deployment-representative repeat can separate code effects from environmental variation.

Phase three’s previously measured batch-edit improvements are separate results; this audit neither remeasures them nor supports a claim that every endpoint is faster.

148,773 measured HTTP calls completed successfully across this audit (plus warmups). The harness rejects non-success HTTP, JSON-RPC errors and tool isError responses. No production writes, deployment, API changes or database pool tuning were performed. This audit does not replace the earlier functional test suite.

## Artifacts and reproduction

[Summary JSON](mcp-tail-audit-2026-10/summary.json) contains all 18 run summaries, five-second windows and trace summaries. [Metadata](mcp-tail-audit-2026-10/metadata.json) records revisions, run order, harness hashes and limitations. The [temporary harness patch](mcp-tail-audit-2026-10/audit-harness.patch) reproduces the corrected audit harness. Individual request JSON, execution logs and both original harness versions remain local under `/tmp/tidy-mcp-latency-audit/`; they are not required to inspect the committed aggregates.

In disposable worktrees, start from the phase-three `performance-benchmark.mjs`, apply the saved patch, and copy that same resulting harness into each revision. Keep each revision’s own migration/init files. The metadata maps the historical measurement commits to their rebased PR equivalents; the capture changes from main are additional to the historical measurements. Run separately, restoring the original harness afterward. Example:

```sh
git apply docs/performance/mcp-tail-audit-2026-10/audit-harness.patch

MCP_BENCHMARK_LOAD=1 MCP_AUDIT_CLIENTS=20 MCP_AUDIT_SECONDS=30 \
  MCP_AUDIT_WARMUP=5 MCP_BENCHMARK_OUTPUT=/tmp/run.json bun run bench:mcp

# Equal offered demand: add MCP_AUDIT_RATE=100 or 300.
# Separate diagnostic run: add MCP_AUDIT_PHASES=1.
```
