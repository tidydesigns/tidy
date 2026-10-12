# Editable raster vectorisation: research, implementation and delivery plan

Research date: 12 October 2026. Branch: `feat/raster-vectorisation`, based on
`origin/main` at `bbb5f8c`. This document distinguishes implemented behaviour,
local measurements, architecture decisions and future work. No production
operation is part of this research.

## Decision and product scope

Implement local, bounded colour tracing with ImageTracer.js 1.2.6 in a dedicated
browser Web Worker. Convert its geometry directly into Tidy native vector nodes,
rather than uploading the generated SVG through the existing importer. Use the
existing image editor, document patches, collaboration queue, history, renderer
and export pipeline. No database migration, provider credential or new service is
needed for this canvas implementation.

The useful output is an editable group of shapes: designers can recolour an
individual region, move anchors and Bezier handles, resize the group, and export
native SVG. Producing a scalable SVG asset alone does not meet this requirement.

This is tracing, not semantic reconstruction. A traced word becomes outlines, not
editable text; a button in a screenshot does not become a reusable UI component.
Photographs and gradients become approximations consisting of colour regions.
PNG transparency is retained where possible, while an opaque JPEG background
remains a shape. Removing backgrounds is a separate interaction and must not be
silently inferred.

The current action handles standalone PNG, JPEG and WebP image layers. Image
fills, component subtrees, variant-bearing subtrees and linked reusable styles
are excluded from conversion until their structural semantics are supported.
Existing SVG assets continue through the existing SVG path import rules.

## Existing stack and integration points

- Next.js 16.3.8 / React 19.2.8 supplies the browser UI; Bun manages workspaces and
  tests. Installed Next documentation was read before implementation, including
  client boundaries, lazy loading and Turbopack worker expressions.
- `packages/design` defines browser-safe documents and native vector contours.
  Editable paths require consistent `d` and contour data, bounded coordinates,
  unique point identifiers, at most 1,000 anchors and 100 contours per path.
  Documents allow at most 5,000 nodes. Existing schemas remain authoritative.
- `packages/design-renderer` renders those paths on the canvas and in exports.
  Quadratic tracing segments are converted to cubic Bezier handles so the
  existing point editor can edit them directly.
- `apps/web/lib/design/svg-path-import.ts` deliberately retains complex SVGs as
  assets. A multicolour traced logo cannot reliably become editable through that
  path. Direct conversion avoids broadening an XML parser or accepting SVG
  scripts, references, effects or external resources.
- `file-editor.tsx` owns `changeDocument`, which computes a patch, optimistically
  commits through the existing room, and records undo history. Conversion uses
  this same path once, rather than storing a parallel document format.
- PostgreSQL stores document JSONB. R2 retains original uploaded assets. Existing
  server membership checks, patch validation and realtime publication still
  apply. Generated native paths do not require a new asset upload.
- Native SVG export previously classified authored contour geometry as
  unsupported and fell back to HTML. This branch now embeds measured vector
  markup as native SVG, while retaining fallbacks for masks, shadows and other
  existing unsupported features. Browser tests check geometry and rendered parity.
  The directly affected vector browser regression script is migrated from `.mjs`
  to typed `.ts`, following repository script preferences, and its old HTML
  expectation is updated to require native paths.
- Cloudflare Workers/OpenNext hosts the server. Browser Web Workers and
  Cloudflare Workers are different runtimes. A browser tracing worker has no
  server credentials and sends no image to a third-party tracing service.
- MCP currently supports reading images and authoring native vectors, but does
  not execute this browser conversion headlessly. An MCP tracing operation needs
  a separately designed execution and authorization path; it is not claimed as
  part of the completed canvas feature.

## Candidate research

| Candidate                                | Verified properties                                                                                                                              | Fit and decision                                                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ImageTracer.js 1.2.6                     | JavaScript RGBA input, colour quantisation, region tracing and quadratic fitting; Unlicense; traced layers are available before SVG output.      | Chosen for the initial local implementation. Small integration surface, no WASM build and direct native geometry conversion. Its old release and memory usage require pinned dependency, bounds and regression fixtures.                         |
| VTracer 1.0.0-alpha.4                    | Rust colour tracing; published npm WASM build; RGBA and encoded image APIs. Package entry imports `fs`, `fs/promises` and Node-target WASM glue. | Strong follow-up candidate. The current npm entry is not a drop-in browser or Cloudflare module. Requires a reproducible web-target build, transitive licence review, worker bundling and native-output adapter.                                 |
| Potrace                                  | Mature binary tracing; GPL distribution with a separate proprietary licensing option.                                                            | Not selected for this Apache-licensed browser feature. Colour decomposition and licensing integration need additional work. The decision avoids assuming that a JavaScript port removes upstream licence conditions.                             |
| Vectorizer.AI API                        | Authenticated bitmap upload with vector output and configurable options.                                                                         | Possible premium server adapter after quality evaluation. Adds credentials, provider cost, data transfer and failure handling. Returning an SVG still requires conversion into native shapes. No paid calls or customer image uploads were made. |
| Custom tracing or learned reconstruction | Region tracing and learned methods address different objectives; reconstruction can favour semantic plausibility over source fidelity.           | Building an entire tracer is unnecessary initially. Learned reconstruction is separate R&D, not a shortcut to reliable editable source geometry.                                                                                                 |

The actual npm packages were inspected, not just their landing pages. VTracer's
published metadata advertises MIT OR Apache-2.0; the reviewed repository root
licence is MIT. A future bundled WASM artefact requires reviewing the package and
its compiled dependencies, not relying only on that root file. ImageTracer's
upstream licence is retained in `licenses/bundled/ImageTracer.txt` and described
in `THIRD_PARTY_NOTICES.md`.

## Pipeline implemented on this branch

### 1. Start from an explicit image action

The existing Image editor exposes one `Vectorise image` action with a palette
limit of 2, 8 or 16 colours, defaulting to 8. It is not duplicated in a toolbar
or context menu. Conversion runs on request, without a save button or delayed
refresh. A cancel action replaces it during tracing. Closing the panel or
changing its keyed image target aborts outstanding work.

The colour setting is a maximum, not a promise to create exactly that many
colours. Similar colours and sparse compression noise may be combined. The
selection is not reset when asynchronous work completes.

### 2. Obtain the authorized original raster

Fetch the existing private asset endpoint using the user's normal session.
Verify the returned MIME is PNG, JPEG or WebP and bound streamed bytes to 2 MB,
even when Content-Length is absent. Do not use the current thumbnail as input.
Use preview URLs only in the existing local fixture mode.

The browser decodes the image. A 16-million-source-pixel limit rejects oversized
decoded sources. This check occurs after browser decoding, so it does not make a
formal predecode-memory guarantee. A later robust header probe can reject large
PNG/JPEG dimensions earlier without changing the decoder's ownership.

### 3. Rasterise the image's current visible content

Trace the displayed image viewport, not the unrelated full source rectangle.
Apply current crop, fit/fill/stretch, focal position, scale and tonal adjustments
using generated SVG with an embedded raster and the same adjustment filter
builder as the renderer. No user SVG markup is parsed or mounted.

Outer rotation, flips, opacity, borders, rounding and effects remain on the
retained group; baking them into the pixels too would apply them twice. Padding
and borders determine the content viewport. Image-only crop and adjustment
properties are cleared on the resulting group because the paths represent them.

Working resolution is bounded to 262,144 pixels and a 1,024-pixel longest edge.
The trace retains that working-coordinate viewBox and renders in the original
canvas dimensions. This bounds tracing memory and cost, but introduces a
resolution/detail tradeoff. Very small details can disappear; large photographic
assets cannot be represented with photographic fidelity under these limits.

### 4. Quantise and fit paths off the UI thread

Transfer the RGBA ArrayBuffer into a freshly created module worker. The tracing
library is in that worker's dependency graph, rather than eagerly imported by
the image editor. Client processing is dynamically imported when requested.

Use deterministic histogram-based palette seeds and frequency-weighted colour
diversity. Exclude isolated noise from palette selection and avoid choosing
nearly identical colours repeatedly. Normalize hidden RGB in fully transparent
pixels. Sparse alpha fringes are treated as edge coverage; substantial partial
alpha regions remain available for translucent shapes. This is a heuristic,
not lossless alpha recovery, and belongs in the quality fixture corpus.

ImageTracer processes colours sequentially, fits lines and quadratic curves, and
reports outer contours and hole children. No random palette sampling is used.
The worker is terminated on cancellation, failure, success or a 20-second
tracing timeout. Synchronous tracing cannot respond to a cancel message while
busy; terminating the worker is therefore the cancellation mechanism.

### 5. Produce native, individually editable shapes

Each non-hole region becomes one native vector child. Its hole contours are
included in the same path with `evenodd` filling. A hole is not painted as a
white shape, so it remains transparent on any canvas background. Convert each
quadratic curve exactly into two cubic controls, using the two-thirds relation
between the quadratic control and its endpoints. Serialize the native contours
and validate against the existing vector schema.

Use explicit solid fill colour and alpha. Disconnected regions remain separate
children rather than one giant uneditable asset. Children use the full image
viewport with consistent viewBoxes, preserving their alignment. Scaling
constraints let the group resize with its descendants.

Bound each trace to 256 shapes, 12,000 total anchors and 1.5 MB of serialized
trace data, alongside existing per-path limits. Reject an excessive result with
an actionable error rather than silently dropping later shapes. Input noise
suppression and minimum path length are intentional tracing approximations;
output-limit enforcement never truncates a successful result.

### 6. Commit once against the current document

Capture a fingerprint of the source asset, image style, dimensions and padding
at start. On completion, read the latest room snapshot; recheck the node,
inherited locks, visibility, source fingerprint, component ancestry and capacity.
If the image changed, reject the stale result. Preserve unrelated changes,
including another layer's edit or the image's rename/move.

Convert the image node into an absolute container while retaining its ID,
parent/page, outer geometry, style and existing references. Insert new vector
children adjacent to it in document order. This keeps comments, interactions and
selection anchored to the same root. Fresh child IDs are assigned at commit;
contour/anchor IDs are deterministic within their individual path.

Commit through `changeDocument` once. Undo restores the image node and removes
all generated paths; redo reapplies the conversion. Existing canonical patch
logic may add benign default image fields, so tests assess persisted behaviour
rather than claiming byte-for-byte object identity across a round trip.

## Local measurements and what they establish

Reproducible harness: `apps/web/scripts/benchmark-raster-trace.ts`. Four synthetic
320×256 artworks (logo with holes, rounded icon, gradient, many small regions),
PNG/JPEG encodings and three colour limits. Each successful scenario uses one
warmup and five measured runs. Source/output comparison uses rendered RGB
composited over white; the reported mean absolute channel error is on a 0–255
scale. These fixtures are not customer data.

Raw results: [ImageTracer and native adapter](raster-vectorisation/imagetracer-results.json)
and [VTracer experiment](raster-vectorisation/vtracer-results.json).

At the default 8-colour limit in the recorded local run:

| Fixture         | Format | Tidy trace median | Native shapes / anchors | Mean channel error |
| --------------- | ------ | ----------------: | ----------------------: | -----------------: |
| Logo with holes | PNG    |          14.25 ms |                  2 / 25 |              0.368 |
| Logo with holes | JPEG   |          11.15 ms |                 8 / 121 |              1.919 |
| Rounded icon    | PNG    |           9.50 ms |                  2 / 44 |              0.727 |
| Rounded icon    | JPEG   |           7.59 ms |                  3 / 68 |              1.447 |
| Gradient        | PNG    |          19.75 ms |                28 / 129 |              4.856 |
| Fine details    | PNG    |          22.93 ms |               120 / 960 |              2.608 |

The fine-detail JPEG exceeded the shape limit for every tested palette and was
rejected. A two-colour limit on the three-colour JPEG logo produced substantial
colour error. These failures are useful limits of the approach, not omitted
outliers. They motivate quality-aware controls and tests rather than raising all
resource bounds.

A direct VTracer experiment used the same available images, poster preset,
8-colour maximum and spline output. Some PNGs traced faster, but its defaults
were not uniformly better in fidelity or region count. The gradient PNG was
poor with that preset. This does not establish an engine ranking: the experiment
excludes VTracer native conversion and browser startup, and more presets could
change its results. The comparison script was temporary; the retained JSON
records its options and scope. Reproducing it requires separately installing the
pinned VTracer package and calling `convertPixels` on the same decoded RGBA.

Tracing timings exclude file fetch, browser decode, visible-image rasterisation,
worker startup, transfer, React painting and server commit. They were measured
in local Bun 1.3.14 on Linux x64, not a mobile browser or Cloudflare. There are no
production speed, peak-memory, p95 or visual superiority claims.

## Delivery plan and acceptance gates

### Phase 1: native canvas feature, implemented here

Deliver the browser worker, native contour adapter, guarded atomic conversion,
one image-editor action, retained licence, unit tests, browser test and benchmark.
Keep the existing schema and production configuration unchanged. Validate both
Turbopack development and Webpack/OpenNext production bundling because worker
assets must work in both builds.

Acceptance: actual PNG/JPEG conversion creates editable paths; holes and colours
survive rendering; crops/adjustments stay coherent; undo/redo works; cancellation
leaves the document alone; stale changes are rejected; generated paths export
through existing SVG tools. The source dependency must remain browser-only.

### Phase 2: quality and performance hardening

Create a larger licensed/synthetic fixture corpus covering low-resolution logos,
JPEG ringing, dark/light backgrounds, nested holes, thin strokes, sharp corners,
semi-transparent artwork, gradients, pixel art and photographic noise. Add
multiple sizes and narrow aspect ratios. Compare rendered error, topology,
region/anchor count and manual edits needed, not just SVG byte size.

Measure browser startup, decode, tracing, commit and first painted result on
Chrome, Firefox and Safari, including a slower phone. Profile memory at the
working-pixel bound, repeated conversions and cancellation. Add early PNG/JPEG
dimension probes if decoding large compressed inputs proves a practical risk.

Consider collapsed advanced controls for detail/noise thresholds and a
side-by-side comparison only after identifying a useful quality tradeoff.
Changing a control must never unexpectedly overwrite a newer design. Any
preview should be ephemeral; accepting its output should still be one commit.

Explicitly test flex/grid fill sizing, responsive layouts, borders/padding,
rotation/flips, rounded clipping, image focal positions and exported appearance.
Do not promise every layout combination based only on standalone-image tests.
Extend reusable style and component support through existing structural
reconciliation with master/instance/variant tests, rather than disabling guards.

### Phase 3: engine evaluation behind the same native contract

Build a pinned VTracer web-target artefact with reproducible Rust/wasm-pack
versions. Audit transitive licences, retain notices and check supply-chain hashes.
Test WASM CSP requirements, lazy worker loading, both Next bundlers, browser
memory and cancellation. Adapt its ordered colour geometry to `RasterTrace`.
SVG output may need transform flattening and carefully bounded path parsing;
prefer a typed geometry output when feasible.

Compare presets, shared-boundary/cutout behaviour and simplification against the
expanded corpus. Replace the default only if quality, editability and execution
cost improve together. Keep the adapter independent so the canvas, history and
server document format do not need redesign.

### Phase 4: headless MCP execution

Define a tool taking an authorized `file_id`, `node_id`, expected revision and
bounded trace options. An agent must not supply arbitrary fetch URLs or a
browser's private asset URL as the authorization boundary.

Separate compute from the final transaction: authorize and snapshot source,
trace outside database locks, then recheck membership, grants, current asset,
source identity and revision before publishing one atomic mutation. Maintain
existing MCP quota admission, metering, activity summaries and rollback. Avoid
holding the workspace write gate while decoding/tracing.

Possible compute paths are a reviewed Worker-compatible decoder plus bounded
WASM, or a separately provisioned compute service. Cloudflare's 128 MB isolate
limit and CPU budget must be measured against realistic source sizes; Node fs
compatibility alone does not make the existing npm package suitable. Larger work
may need asynchronous jobs and limits, with a user-visible cancel/result state.
A hosted premium provider is another adapter, with private credentials, explicit
provider behaviour, quotas, retention/error handling and cost accounting.

This phase needs a concrete infrastructure choice and representative load data.
It is intentionally not simulated by calling a client worker from MCP. Any
production deployment or configuration/database change remains an operator
approval step under the repository rules.

## Verification and operational boundaries

Run from the repository root:

```sh
bun test apps/web/lib/design/raster-trace.test.ts apps/web/lib/design/raster-vectorisation.test.ts
bun apps/web/scripts/benchmark-raster-trace.ts
RASTER_TRACE_TEST_URL=http://localhost:3168 bun apps/web/scripts/test-raster-vectorisation-browser.ts
VECTOR_TEST_BASE_URL=http://localhost:3168 bun apps/web/scripts/test-vector-browser.ts
bun typecheck
bun lint
bun test
bun run build
bun run test:release
bun run audit:dependencies
bun run build:worker
```

The browser test uses the existing development-only image fixture in local mode
and intercepts its asset URL with synthetic PNG/JPEG/WebP bytes. Start a local
Next dev server with dummy local analytics settings; that fixture requires no
live database or hosted-service credentials. The worktree contains the required
symlink to the primary checkout's `apps/web/.env.local`; never copy its values
into this document or test artefacts. Final observed verification is recorded in
[verification](raster-vectorisation/verification.md).

## Primary sources reviewed

1. [ImageTracer repository/API and licence](https://github.com/jankovicsandras/imagetracerjs).
2. [ImageTracer pipeline](https://github.com/jankovicsandras/imagetracerjs/blob/master/process_overview.md).
3. [ImageTracer options](https://github.com/jankovicsandras/imagetracerjs/blob/master/options.md).
4. [VTracer repository](https://github.com/visioncortex/vtracer).
5. [VTracer Node WASM API](https://github.com/visioncortex/vtracer/blob/master/nodejs/README.md).
6. [VTracer Node entry source](https://github.com/visioncortex/vtracer/blob/master/nodejs/index.js).
7. [VTracer repository licence](https://github.com/visioncortex/vtracer/blob/master/LICENSE).
8. [Potrace author site and licensing](https://potrace.sourceforge.net/).
9. [Vectorizer.AI API documentation](https://vectorizer.ai/api/documentation).
10. [MDN transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects).
11. [MDN worker termination](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate).
12. [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas).
13. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
14. [Cloudflare WASM runtime](https://developers.cloudflare.com/workers/runtime-apis/webassembly/).
15. [Image Vectorization: a Review](https://arxiv.org/abs/2306.06441), research context rather than an implementation dependency.

Browser decode plus transferred pixels was selected over mandatory
OffscreenCanvas decoding to keep the worker's input plain and bounded and avoid
requiring another browser capability for the initial release. OffscreenCanvas
is a future optimisation if profiling shows main-thread rasterisation matters.
