# Editor performance evidence

- [Document processing and sparse editing](./editor-2026-10.md): original baseline comparison, methodology and limitations.
- [Bulk selection and dragging](./editor-selection-2026-10.md): targeted follow-up, the regression it uncovered and the corrected comparison.
- [Raw measurements](./editor-2026-10/): synthetic JSON results. File names distinguish baseline, optimized, control and exploratory runs. These records remain tied to the implementations described in their reports; maintenance changes do not retroactively replace them.

Run the TypeScript harnesses from the repository root:

```bash
bun apps/web/scripts/benchmark-editor-kernel.ts
EDITOR_TEST_URL=http://localhost:3117 bun apps/web/scripts/benchmark-editor-browser.ts
EDITOR_TEST_URL=http://localhost:3117 bun apps/web/scripts/benchmark-editor-selection.ts
```

Browser harnesses require a running loopback fixture server, with the local production-build opt-in described in the reports. They block external and API requests. `apps/web/scripts/editor-benchmark.ts` shares fixture routing, browser cost calculations, percentile calculation and report output; it contains no application runtime code.

Implementation responsibilities:

- `packages/design/document.ts` owns schemas, graph validation and the public parser API. `immutable-document.ts` encapsulates parser-owned frozen state and bounded reuse caches, initialized through a factory to avoid runtime import cycles.
- `packages/design/vector-relationships.ts` owns the shared mask eligibility rules and per-batch hierarchy indexing.
- `apps/web/app/files/[uid]/artwork-branches.ts` owns artwork subtree reuse and invalidation; React rendering stays in `canvas-artwork.tsx`.
- Shared-model tests are colocated in `packages/design/`. Editor transaction and queue integration tests stay in `apps/web/lib/design/immutable-editor.test.ts`; artwork cache tests stay alongside the renderer.

The architecture review preserved existing targeted coverage and added one concrete regression test for sibling reordering with unchanged node identities. Stable token references ensure cache tests exercise real reuse/invalidation rather than accidentally forcing every branch to rebuild. Mask APIs share one set of rules, with a lazy batch index so text/vector-only selections avoid an unnecessary whole-document index.
