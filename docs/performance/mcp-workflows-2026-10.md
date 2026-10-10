# MCP workflow performance: second pass

This pass compares against `f69ff1b`, the already optimized implementation from the [first report](mcp-2026-10.md). It measures time to finish a design change, checks component correctness, and exercises browser capture → authenticated MCP → editable design → rendered preview locally. Measurements were taken on October 10, 2026, on the same Apple M5 / Bun 1.3.14 / PostgreSQL 17.11 environment.

## User outcomes

Thirty measured workflows per scenario, after five warmups, over real loopback HTTP with the actual MCP route and disposable PostgreSQL. Latency includes the entire response body. The 20-layer scenario also reads back and verifies all edited values.

| Outcome                                            | Median before → after | p95 before → after | Improvement |
| -------------------------------------------------- | --------------------: | -----------------: | ----------: |
| Edit 20 layers in a 5,000-node document and verify |     886.70 → 54.05 ms |  962.14 → 56.36 ms |       16.4× |
| Edit a master with 1,500 linked nodes              |     295.65 → 84.62 ms |  374.23 → 90.89 ms |        3.5× |
| Retrieve import guidance                           |        6.81 → 3.22 ms |     7.94 → 4.76 ms |        2.1× |
| Retrieve design guidance                           |        7.35 → 3.23 ms |    11.60 → 4.73 ms |        2.3× |

The 20-layer workflow falls from **21 MCP calls / 519 SQL statements to 2 calls / 44 statements**. It produces the requested final layer values with one atomic edit revision. The existing single-edit API, default full-document response, optimistic concurrency, permissions, locks, and component inheritance remain supported. A batch consumes one admitted MCP call, consistent with the existing per-call quota contract.

Use the existing `patch_document` tool, with its first edit and up to 249 `additional_edits`. Edits apply in order, including repeated node IDs. An invalid final document or missing batch target prevents the entire commit. Locked-layer behavior and inherited overrides follow existing edit semantics. `include_document: false` returns compact acknowledgments; read affected pages again when component propagation changes other layers.

```json
{
  "file_id": "your-file",
  "expected_revision": 12,
  "node_id": "heading",
  "changes": { "text": "Create your workspace" },
  "additional_edits": [{ "node_id": "button-label", "changes": { "text": "Get started" } }],
  "include_document": false
}
```

Import guidance falls from 452,581 to 171,617 response bytes; design guidance from 411,495 to 158,963 bytes. Static guidance/schema conversion and serialization are reused, with local JSON Schema references removing repeated definitions. Authorization and user data are never cached by this optimization.

Raw workflow measurements: [before](mcp-workflows-2026-10/workflows-baseline.json), [after](mcp-workflows-2026-10/workflows-optimized.json).

## Algorithm experiments and complexity

Let **N** be the number of document nodes, **A** the affected component copies, **K** the requested edits, **J** the serialized document size, and **S** a component subtree size. Costs below distinguish ordinary property edits from arbitrary structural changes; they do not assume every document is a flat list.

| Work                                   | Previous cost                                                                                | Current cost / limit                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Propagate a property edit              | Scan N nodes for each affected source: O(N × A), plus patch work                             | Build a source-to-copy index once, then visit affected copies: O(N + A), plus patch work                                                                      |
| Remap copied interactions/masks        | Repeated candidate scans and ancestry-map construction                                       | Lazy per-operation instance/source lookup; ancestry and references indexed once, then constant-time lookups                                                   |
| Reconcile unchanged component topology | Repeated whole-array filtering, copying, order scans, and map construction for each instance | Parent/order indexes per array; reuse identical canonical subtrees. O(N) for bounded-size independent instances; subtree sorting adds O(S log S) where needed |
| Expand token override exclusions       | Revisit every binding/property relationship for every copy                                   | Precomputed fixed relationship index; process supplied paths and relevant groups, preserving exact order/duplicates                                           |
| Apply K separate edits                 | K validations, serializations, stores, and authorization/admission sequences                 | One final validation, serialization, store, and admission. Ordered edit application can still be O(K × N); it is not falsely advertised as O(K)               |
| Persist a document edit                | O(J) JSON transfer/storage                                                                   | Still O(J), because the current architecture stores a whole JSONB document                                                                                    |

Arbitrary structural reconciliation can still rebuild arrays/indexes after topology changes; the optimization does not claim a linear bound for all nested component graphs. Complete validation remains enabled. The document model's bounded ancestor depth also remains enforced.

The isolated algorithm benchmark uses 100, 500, 1,500, and 5,000 linked nodes, five warmups and 20 samples per operation. At 5,000 nodes:

| Experiment                                         | Complete edit median | Reconciliation median | Propagation median |
| -------------------------------------------------- | -------------------: | --------------------: | -----------------: |
| Previous implementation                            |          1,587.87 ms |           1,257.40 ms |          227.12 ms |
| Index traversal and avoid unchanged subtree copies |            182.66 ms |              13.18 ms |          123.60 ms |
| Also precompute token exclusion relationships      |             39.40 ms |              13.86 ms |            6.52 ms |
| Final repeat                                       |             33.77 ms |              12.99 ms |            6.28 ms |

The complete edit includes propagation, reconciliation, import-change tracking, and full validation. It excludes HTTP/database work. Its approximately 47× gain does **not** mean a 47× improvement in persisted MCP edits; the HTTP results above include the remaining database costs.

Raw algorithm results: [baseline](mcp-workflows-2026-10/kernel-baseline.json), [index-only experiment](mcp-workflows-2026-10/kernel-index-only.json), [exclusion-index experiment](mcp-workflows-2026-10/kernel-optimized.json), [final repeat](mcp-workflows-2026-10/kernel-final.json).

A separate batch-tool experiment achieved the desired edit latency but increased discovery from 267,394 to 300,671 bytes. It was rejected in favor of an optional argument on `patch_document`, which reuses its existing change schema. Final discovery is **267,881 bytes**, only 487 bytes more than before. [Rejected experiment measurements](mcp-workflows-2026-10/workflows-separate-tool-experiment.json) are retained to make that decision reviewable.

## Existing operations and sustained load

A separate 100-sample comparison checks that the new workflow does not move cost onto ordinary calls:

| Existing operation             | Median before → after | p95 before → after |
| ------------------------------ | --------------------: | -----------------: |
| Legacy discovery               |        2.64 → 2.26 ms |     4.46 → 3.48 ms |
| Modern discovery               |        2.07 → 2.28 ms |     3.31 → 4.57 ms |
| Small document read            |        2.98 → 2.83 ms |     6.53 → 4.10 ms |
| Five concurrent document reads |        6.59 → 6.39 ms |     8.98 → 8.59 ms |
| Rename                         |        3.09 → 3.19 ms |     4.16 → 4.28 ms |
| Full 5,000-node edit           |      49.02 → 49.38 ms |   52.66 → 54.82 ms |
| Compact 5,000-node edit        |      42.18 → 42.67 ms |   46.49 → 46.54 ms |

These small differences are reported, not hidden. Single-run local distributions do not establish statistical equivalence or a universal latency guarantee. The substantial improvement is completing coordinated edits and linked-component updates; unrelated operations remain in their previous latency range. [Common-operation baseline](mcp-workflows-2026-10/common-baseline.json), [optimized](mcp-workflows-2026-10/common-optimized.json).

The sustained test replenishes each client immediately after a response for five seconds per concurrency level, then drains outstanding requests. It uses one workspace, 80% small document reads and 20% real rename writes. All responses are consumed and checked for HTTP, protocol, and tool errors.

| Concurrent clients | Requests/sec before → after | p95 before → after | p99 before → after |
| ------------------ | --------------------------: | -----------------: | -----------------: |
| 1                  |             335.40 → 324.51 |     4.33 → 4.11 ms |     6.37 → 5.58 ms |
| 5                  |             645.35 → 659.99 |   11.89 → 11.53 ms |   19.55 → 14.30 ms |
| 20                 |             627.62 → 647.56 |   41.43 → 36.80 ms |   56.98 → 40.83 ms |
| 50                 |             591.77 → 649.45 |  118.63 → 86.95 ms |  137.33 → 98.60 ms |

The optimized run completed 11,442 calls with no rejected responses. Throughput levels off near 650 calls/sec on this local process/database configuration. More concurrency then adds queueing; there is no claim of unlimited capacity. This is a short closed-loop capacity probe, not an open-loop overload test, long-duration soak, or deployed capacity estimate. [Load baseline](mcp-workflows-2026-10/load-baseline.json), [optimized](mcp-workflows-2026-10/load-optimized.json).

## Browser-to-design validation

The T3 collaborative browser opened the actual `apps/site` homepage served by Next.js locally. It obtained the browser capture script through authenticated MCP, captured the rendered page, imported it through `import_web_capture`, read it back, and exported a self-contained HTML preview using the real Tidy renderer. The captured CSS viewport was 1,536 × 960. Seven text layers remained editable, with nine total layers after retaining the link border.

This exposed and fixed two pre-existing capture defects: a selected transparent region failed to inherit its ancestor's background, and bottom-only borders were omitted. The final capture retains the site's `#f2f2f0` background and orange 4px link underline.

The source uses Next-local font aliases. The fixture explicitly resolves those aliases to Instrument Sans/Instrument Serif and corrects the logo's measured line-box position through one batched MCP edit. A deterministic font-provider fixture supplies the exact checked-in WOFF2 files to the real preview font packager; this is not a measurement of Google font download latency or automatic arbitrary-font recovery. The final exported preview has no font warnings. The source and output were inspected visually, including text wrapping, colors, the logo, and the underline. This is a measured static desktop reconstruction, not a claim to reproduce responsive behavior or website interactions automatically.

The same browser then used `get_design_guidance`, `compose_component`, and `instantiate_component` on the repository's button example. It staged, validated, and committed one master with secondary/danger instances, changed radius/padding and shared label in one MCP batch, read the result back, and rendered all three variations. Browser checks confirmed `Create design` on every variant, 12px corners, 10px/24px padding, no text overflow, and the expected primary/secondary/danger fills. Revision advanced once for the batch; final previews reported no rendering warnings.

The scripted smoke workflow took 210 ms from an already rendered source page through both completed exports (130 ms for the website portion). This is **one local smoke run**, excluding navigation, model reasoning, initial page/font loading, and human visual inspection. It is not presented as a repeated end-to-end latency benchmark. [Per-call measurements](mcp-workflows-2026-10/browser-workflow-calls.json) and the [browser driver](../../apps/web/scripts/fixtures/mcp-workflow.js) make the work inspectable.

## Reproduce and verify

From the repository root, with Bun and PostgreSQL binaries installed:

```sh
# Complete design workflows; baseline omits MCP_BENCHMARK_BATCH.
MCP_BENCHMARK_WORKFLOWS=1 MCP_BENCHMARK_BATCH=1 \
  MCP_BENCHMARK_SAMPLES=30 MCP_BENCHMARK_COMPACT=1 \
  MCP_BENCHMARK_OUTPUT=/tmp/mcp-workflows.json bun run bench:mcp

# Ordinary calls, algorithm scaling, and sustained mixed load.
MCP_BENCHMARK_SAMPLES=100 MCP_BENCHMARK_COMPACT=1 bun run bench:mcp
MCP_BENCHMARK_OUTPUT=/tmp/mcp-kernel.json bun apps/web/scripts/benchmark-design-edits.ts
MCP_BENCHMARK_LOAD=1 MCP_BENCHMARK_OUTPUT=/tmp/mcp-load.json bun run bench:mcp

# Two terminals for browser validation. The second owns an isolated database.
bun run --cwd apps/site dev --hostname 127.0.0.1
MCP_WORKFLOW=1 MCP_WORKFLOW_OUTPUT=/tmp/tidy-mcp-workflow bun run bench:mcp
```

Open `http://localhost:3001/` in the T3 browser. Take a source screenshot, then execute this in its page context:

```js
(0, eval)(await (await fetch("http://127.0.0.1:4319/client.js")).text());
await runTidyMcpWorkflow();
```

Open both returned preview URLs and inspect the website and variant controls. JSON measurements, captured document data, and standalone preview HTML are saved under `MCP_WORKFLOW_OUTPUT`. The local bridge supplies a synthetic grant and forwards calls over HTTP to the actual authenticated MCP route. It is loaded only by the disposable test fixture; no bypass or bridge endpoint is added to the deployed application. Browser access is restricted to the listed loopback origins. Stop the fixture and remove its database with `curl -X POST http://127.0.0.1:4319/finish`.

For a baseline worktree at `f69ff1b`, copy only `performance-benchmark.mjs` and `scripts/benchmark-design-edits.ts` from this revision into the corresponding `apps/web` paths, install that revision's locked dependencies, and run the same benchmark commands without `MCP_BENCHMARK_BATCH`. Run benchmarks separately from builds and test suites. Raw CPU measurements cover the entire Bun benchmark process, not isolated Worker CPU.

Regression coverage includes ordered/repeated edits, inherited overrides and constraints, stale revisions, graph/asset/target rejection with rollback, legacy and July 2026 MCP dispatch, token exclusion compatibility, unchanged-subtree identity/order, and the capture border fix. A 400-case deterministic comparison against the previous component implementation also matched additions, deletions, shuffled order, overrides, and propagation. Full validation, authorization, independent quota admission, and publication checks remain enabled.

Final checks passed: 150 MCP database tests (856 assertions), 735 unit tests (660 database-gated tests skipped in that command), 21 multiplayer database tests, six version/history database tests, type checking, lint/formatting, the standard production build, the OpenNext Worker build, and three release tests. The Worker build excludes private environment values. Database tests use independent disposable clusters.

The remaining full-document JSONB write cost, arbitrary structural graph changes, hosted placement, external API/font latency, cold starts, and real production load remain distinct constraints. No production data, configuration, or deployment was changed. This pass establishes measured improvements and tested behavior; it does not establish an absolute performance ceiling or prove that a language rewrite is necessary.
