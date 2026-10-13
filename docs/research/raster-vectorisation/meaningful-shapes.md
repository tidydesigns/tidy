# Meaningful editable shapes

Follow-up implementation on `feat/meaningful-vector-shapes`, based on the latest
`origin/main` (`dddb3f4`) and carrying forward the original vectorisation commits.

The original browser evaluation exposed 49 layers in a three-colour icon and
123 layers in a small flat illustration. Those were tracing artefacts, not useful
objects. This change improves geometric reconstruction without adding an external
service, AI credentials, image uploads or model inference.

## Behaviour

- Resolve coverage alpha against nearby interiors. A half-covered stroke edge
  does not become a separate translucent shape. Preserve solid translucent fills.
- Choose modal colours from deterministic histograms and retain small flat cores.
  Exclude small blends of existing paints from the palette where appropriate.
- Classify confident interior pixels using premultiplied colour distance, then
  propagate ambiguous edge labels from adjacent regions in simultaneous distance
  waves. This stops a green/cream boundary from becoming yellow fragments.
- Freeze the resulting labels and palette before fitting contours.
- Fit ellipses, rectangles and uniformly rounded rectangles only when their
  boundaries agree within roughly one working pixel. Retain native cubic handles.
- Fit unsupported coverage edges to nearby converged alpha crossings, bounded
  to 0.8 working pixels, to reduce thickening from thresholded stroke outlines.
- Recover complete opaque primitives behind enclosed opaque artwork. Preserve
  actual transparent holes and translucent intersections.
- Recover a convex triangle across occluding paints only after checking its
  missing interior against the pixel labels. Foreground paints must occupy less
  area than the candidate; larger background gaps and transparency reject the
  reconstruction. Allow at most four ambiguous background pixels. Triangle hull
  simplification tolerates 1.8 working pixels of raster corner artefacts.
- Keep disconnected same-colour objects separate unless the validated triangle
  reconstruction explains their separation. Never combine everything by colour.
- Omit collapsed straight contours with zero filled area. Keep two-anchor curves.
- Give every resulting node its own bounds and corresponding vector viewBox,
  so selecting/moving a small accent uses its own selection rectangle.
- Trace upscaled images at their available source density, avoiding artificial
  interpolation detail. Account for crop, fit and zoom when choosing that density.

## Browser evidence

The same synthetic PNG inputs were converted through the actual image-editor
button in Chromium, not imported directly as SVG. Every layer was isolated and
selected in the canvas, with screenshots and individual SVGs. The icon's leaf was
moved independently, recoloured, and the accent entered point editing with four
anchors. The rounded background remained complete after leaf movement.

| Fixture                    | Previous paths | Revised paths | Previous white RGB MAE | Revised white RGB MAE |
| -------------------------- | -------------: | ------------: | ---------------------: | --------------------: |
| Leaf icon                  |             49 |             3 |                  1.331 |                 0.778 |
| Flat house illustration    |            123 |            11 |                  2.137 |                 0.427 |
| Architectural line drawing |             26 |             3 |                  0.648 |                 1.668 |

MAE compares the native SVG export against the decoded raster at 624 × 380,
composited over white, excluding the fixture's 10px outer border. Lower is better.
The line drawing gains coherent shapes but loses some edge fidelity; it remains
filled outlines rather than recovered editable centre-line strokes. Counts alone
are insufficient evidence of quality. The illustration's recovered mountain has
one contour and three anchors, rather than separately clipped pieces. Some other
layers, including the house body and the second mountain, retain occlusion cuts.

The complete evaluation covers ten images at 2, 8 and 16 colours, including a
NASA photograph, gradients, translucency and compression stress cases. Difficult
cases remain in the results. Most photos exceed the existing complexity limits;
continuous gradients become bands; a 96px heavily compressed JPEG still has
unhelpful fragments and colour error. These are unresolved quality gaps.

Browser screenshots and interactive layer gallery are local ignored artifacts:
`.artifacts/shape-inspection/quality-review.html`. Full 30-attempt measurements,
SVG exports, differences and conversion video live in
`.artifacts/vectorisation-quality/`. They contain no customer data.

Reproduce the focused regression check with a local development server:

```sh
RASTER_TRACE_TEST_URL=http://localhost:3169 \
RASTER_TRACE_ARTIFACTS=/tmp/tidy-raster-shapes-browser \
bun apps/web/scripts/test-raster-shapes-browser.ts
```

Use the existing `/dev/import-preview?edit=1&images=1` fixture. The script
intercepts its image URL, auth lookup and analytics with local synthetic data.

## Scope and remaining limitations

This recognises geometric structure, not semantic subjects. It does not label
“house”, infer components, recover text/fonts, or reconstruct arbitrary hidden
artwork. Native nodes remain editable paths even when named Ellipse or Rectangle.
Occlusion recovery uses conservative visual evidence and can decline plausible
reconstructions. A richer AI image-to-SVG pipeline would require separate engine,
privacy, cost, fidelity and SVG-import evaluation.

Unit regressions cover fixture topology, colours, rendering error, primitive
anchors, actual holes, same-colour independent objects, blocked background gaps,
source concurrency and independent node bounds. Browser checks cover individual
layer selection, movement, recolouring, point editing, export and undo/redo.

## Verification

Validated on 13 October 2026 with repository-required Bun 1.3.14 and Playwright
Chromium. Root `bun typecheck`, `bun lint` and `bun run build` pass. The full suite
passed with 808 tests and 665 database-gated skips; the two subsequently added
occlusion safeguards also passed in the focused suite. An initial concurrent
check hit the existing 5-second large-document deletion test timeout; the full
suite passed on rerun. No database integration or production operation is claimed.

The full browser matrix recorded 25 completed conversions and five guarded
rejections with zero page errors. All successful exports contain native paths,
with no embedded raster or HTML fallback; undo/redo passed. Default eight-colour
results contain 42 anchors for the icon (previously 216), and 77 for the
illustration (previously 366). Observed conversion times for the three focused
fixtures were around half a second in this desktop run, not a general benchmark.
