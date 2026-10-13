# Bulk selection and dragging: October 2026

The original editor optimization and its 5× single-layer editing result did not establish bulk-selection or dragging performance. This follow-up measures those workloads directly and adds targeted fixes on `perf/editor-incremental-processing`, after commit `a069cb0`. Baseline: `origin/main` at `dddb3f4`.

## Measured results

Production-build Chromium on the same desktop as the original report, 4× CPU throttling, identical dense sibling scenes in both checkouts. Final order: baseline / corrected optimized / corrected optimized / baseline. Values below are medians of per-run median latencies in milliseconds. Lower is better.

| Selected layers | Select: baseline → corrected | Selection speedup | Drag preview: baseline → corrected | Drag speedup | Release: baseline → corrected | Release speedup |
| --------------- | ---------------------------: | ----------------: | ---------------------------------: | -----------: | ----------------------------: | --------------: |
| 100             |             110.0 → 117.6 ms |             0.94× |                     61.9 → 60.0 ms |        1.03× |               107.2 → 75.2 ms |           1.42× |
| 1,000           |             602.5 → 442.8 ms |             1.36× |                   406.2 → 295.9 ms |        1.37× |              654.2 → 354.6 ms |           1.84× |
| 4,999           |           4274.6 → 1731.2 ms |             2.47× |                 3013.0 → 1204.7 ms |        2.50× |            5437.4 → 1423.2 ms |           3.82× |

At 4,999 selected layers, selection latency fell about 59.5%, drag-preview latency about 60.0% and release-frame latency about 73.8%. Aggregate browser task time for the drag exercise fell from 30,323.25 to 11,933.45 ms; script time fell from 26,864.30 to 9,011.80 ms. Layout time changed much less (138.90 → 128.05 ms). This points primarily to JavaScript savings rather than a large reduction in layout cost. No CPU call-stack profile was collected.

There is no meaningful dragging win at 100 layers, and selecting 100 layers was slightly slower (110.05 → 117.60 ms). Drag-start latency was essentially unchanged at 1,000 and 4,999 layers (33.90 → 34.25 ms and 146.70 → 148.95 ms); at 100 layers it was 17.90 → 24.85 ms. These short samples do not establish statistical equivalence or precise small-workload regressions.

The largest drag-preview median remains about 1.2 seconds under throttling. This is a substantial improvement, but bulk dragging is still too slow for fluid interaction. It does not meet a display-frame budget.

## What the new test exposed

The prior optimized build (`a069cb0`) had a significant bulk-selection regression. In the initial correctly instrumented probe, selecting 4,999 layers took 16,215.7 ms versus 4,964.4 ms on the baseline; drag previews were 4,527.9 versus 3,142.8 ms. These are one-run exploratory figures, retained in `selection-prior-optimized.json` and `selection-baseline-exploratory.json`, not the final headline comparison. The original single-layer benchmark missed this case.

The inspector called `vectorMaskSource` independently for every selected container. Each call filtered the entire document to find children, then recursively repeated that process. For thousands of selected containers, this produced quadratic document scans. The immutable editor state made the missed workload materially worse in the observed prior build; the contribution of V8 representation and freezing effects was not isolated.

## Targeted fixes

- Added `vectorMaskSources`, which builds one parent/children index per synchronous batch and memoizes descendant eligibility within that batch. It preserves candidate order, rendered candidate styles and the existing mask rules. It retains no cache across mutable caller updates. The original single-candidate `vectorMaskSource` API and its behavior remain unchanged.
- Replaced inspector membership checks that searched `selectedIds` for every document node with a memoized selection Set.
- Reused the existing node-ID map for selected-parent and common-parent checks instead of searching the node array once per selected layer.

These changes keep the DOM/CSS renderer, selection UI, pointer capture, snapping semantics, preview pipeline and canonical edit/history paths. They do not introduce an imperative translation renderer or change which layers can be selected or moved. The existing requestAnimationFrame pointer batching predates this work.

## Method and correctness

The diagnostic fixture has one artboard with 100, 1,000 or 4,999 unlocked, fixed-size rectangular siblings. Document totals are 101, 1,001 and 5,000 nodes. All artwork stays mounted in this dense scene: selected-layer pinning and artboard-level culling do not bound it to the 300 mounts observed in the earlier sparse-scene test.

Each case uses one warmup selection and three measured Ctrl+A selections from a selected sibling. Resets use Escape and Enter. A completion marker requires the last sibling to be selected and the aggregate scale control to exist; it then waits two animation frames. Every selection checks the exact selected count. The viewport is fitted again after the inspector opens, and a hit test verifies the drag starts on actual artwork rather than a resize handle or sidebar.

Dragging uses real Playwright mouse events and pointer capture: six move events, with the first two excluded from preview percentiles. Each pointer move advances 20 screen pixels, waits for a changed DOM position and the next animation frame, then allows another frame before the next input. Window capture listeners start timers before React capture handlers; drag-start and release markers wait two animation frames. Ctrl is held during movement to bypass snapping and guarantee a verifiable nonzero delta. All siblings must move by the same delta. One undo must restore every sibling to its original position. Every case checks zero page errors.

There are two independent runs per version, with only three selection samples and four drag-preview samples per case per run. These are exploratory latency comparisons, not statistically powered measurements. Raw p95 fields with so few samples are effectively maxima; they should not be presented as established tail distributions. Paced inputs do not test sustained 60 Hz pointer traffic, coalescing, dropped frames or queue saturation. Frame markers are DOM/rAF proxies, not GPU presentation latency or real-user INP.

Baseline and optimized production builds use the same additional diagnostic scene and loopback fixture gate. Only one benchmark browser runs at a time; builds and the full check suite were completed before final repetitions. Browser routing blocks external requests, auth/API access and file prefetches. There is no working database and no deployed or customer data. Other desktop activity was not controlled.

The fixture does not cover marquee selection, selection spanning artboards, deep hierarchies, linked component propagation during bulk drag, rotated/flipped parents, responsive constraints, effects, snapping, mobile devices or real multiplayer updates. These remain required workloads for a comprehensive gesture optimization effort.

## Validation

`bun typecheck`, `bun lint`, `bun test` and `bun run build` passed on the corrected source. Web test summary: 804 passed, 665 skipped, zero failures, 14,425 assertions. Database-gated tests remain skipped. New eligibility tests compare batch results with independent recursive evaluation for nested, empty, painted, image, vector and text candidates; preserve rendered candidate styles and ordering; check mutable changes between calls; and exercise 60 changes across a 200-node hierarchy. The final browser runs additionally verify all bulk movement and one-step undo results.

## Next substantial gains

The drag preview still prepares moves and schema-parses every changed node, publishes a new document snapshot, renders changed artwork, and derives inspector geometry through DOM reads. These costs remain in `previewMoveLayers`, `useRenderedSelection`, multi-selection measurements and gesture setup. The next pass should measure and reduce those operations, rather than assume that existing frame batching makes the callback cheap.

Priorities: cache gesture roots/affine transforms and geometry with invalidation on concurrent document changes; derive live inspector position from the gesture delta instead of remeasuring every moved layer; investigate a temporary translation preview that preserves component, constraint and cancellation behavior and produces one canonical history entry on release; and measure offscreen selection mount pressure. Avoiding repeated layout reads follows [web.dev’s layout guidance](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing). The current implementation already retains the latest preview per animation frame; [MDN’s pointer-event documentation](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents) explains why input coalescing and sampling also need explicit testing.

## Reproduce

Build both checkouts with the local configuration described in the [original performance report](./editor-2026-10.md). Apply the same diagnostic scene function and route selection query to the baseline; its application implementation stays at `dddb3f4`. Start the loopback servers with `TIDY_LOCAL_PERFORMANCE_FIXTURES=1`, then run the same harness sequentially:

```bash
EDITOR_TEST_URL=http://localhost:3117 EDITOR_BENCH_OUTPUT=/tmp/selection-baseline.json bun apps/web/scripts/benchmark-editor-selection.ts
EDITOR_TEST_URL=http://localhost:3118 EDITOR_BENCH_OUTPUT=/tmp/selection-optimized.json bun apps/web/scripts/benchmark-editor-selection.ts
```

`EDITOR_SELECTION_COUNTS=1000` limits a run to one supported case. The fixture URL is `/dev/performance-preview?selection=1000`; supported selection counts are 100, 1,000 and 4,999.

[Harness](../../apps/web/scripts/benchmark-editor-selection.ts). [Raw data and summary](./editor-2026-10/): `selection-baseline-1/2.json`, `selection-optimized-1/2.json`, `selection-summary.json`, plus the two clearly labeled exploratory/prior files.
