# Raster vectorisation verification

Validated locally on 12 October 2026 using Bun 1.3.14, Node 26.8.1 and
Playwright Chromium on Linux x64. All artwork is synthetic.

- Root type checking: passed across all workspaces.
- Root lint and formatting: passed.
- Full unit suite: 782 passed, 665 database-gated tests skipped, zero failures.
  The skipped suites are not claimed as database integration coverage.
- Release suite: three passed.
- Dependency audit: passed under the repository policy; it reports the existing
  documented `braces` tooling advisory. No new runtime advisory was reported.
- Raster browser suite: PNG, JPEG and WebP become separate editable vector
  layers; appearance errors were 0.367, 1.231 and 0.527 mean channel units in the
  fixture screenshots. Undo/redo passes for all three formats.
- Cropped, zoomed, adjusted PNG conversion: passed, mean channel error 0.380.
- Native SVG export: contains paths, no embedded raster image; rendered output
  agrees with the canvas under the fixture's background and screenshot bounds.
- Cancellation through panel close and explicit cancel: passed; original image
  remains unchanged. Browser page errors: zero.
- Existing vector browser suite: passed transformed anchor/handle drags, point
  controls, segment insertion/deletion, pen close/cancel, undo, SVG/PNG/WebP
  exports, supported SVG imports and unsupported-feature fallbacks.
- Core regressions cover deterministic output, alpha/hole handling, geometry
  bounds, complexity rejection, retained node identity, patch round trips,
  concurrent source changes, locks and unsupported component/style contexts.

- Standard production build: passed across web, site, extension and plugin.
- Webpack/OpenNext Cloudflare Worker build: passed; browser worker assets are
  bundled and private environment values are excluded. The build retains the
  existing Paper.js `require.extensions` warning.

Builds use a synthetic extension origin and never deploy. The prescribed environment symlink points to a missing file in
this checkout; it is temporarily removed during builds and restored afterward.
No primary environment file is created or overwritten.

An initial run with the machine's Bun 1.4.2 failed two generated-runtime checks.
Those checks pass unchanged with the repository-required Bun 1.3.14; generated
runtime files were not rewritten to accommodate the unrelated toolchain.

Benchmark harness and measured engine scope are documented in the adjacent
[research and plan](../raster-vectorisation.md). These results are not mobile,
production latency or peak-memory measurements. No production data, database
schema, credentials, network configuration or deployment was changed.
