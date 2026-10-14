# Importing Figma designs


On the Files screen or in a folder, choose **New file → Import from Figma…**
or drop a Figma Design `.fig` local copy. The dialog lets you choose the file
and select pages before creating a Tidy file in the current folder. Imported
files open immediately in the editor. To bring selected elements into an open
file, copy them in Figma and paste with the keyboard or Tidy's paste action.
No Figma plugin or account token is required.

The importer translates source records into editable native layers. It preserves
pages, hierarchy, paint order, supported vector geometry, images, text marks,
Auto Layout (including space-evenly), and resolvable component instances with overrides. Component masters
needed by a pasted instance live on an **Imported components** page. Color
variables become named snapshots; aliases and modes do not remain live bindings.

Alpha/luminance masks with supported vector sources or simple PNG image surfaces are
preserved as editable groups. Image masks use the original asset directly through
CSS masking, avoiding a second raster copy or per-frame image processing. Text
range bold, italic, underline and strikethrough marks remain editable.

This is a compatibility importer, not a guaranteed 1:1 round trip. Complex masks,
per-range font families/sizes/colors, complex component overrides/scales, variant axes, image crop transforms,
unsupported paints and effects can differ. Import notes identify approximations;
repeated notes are grouped. Fonts must be available to Tidy. FigJam and Slides are
not supported, and clipboard images without embedded bytes require a `.fig` copy.
The binary format is unofficial: decoder dependencies are pinned and regression
fixtures should be refreshed when Figma changes its exports.

Parsing runs in a disposable browser worker with a 20-second timeout. Limits are
32 MB input, 64 MB expanded data, 10,000 native layers, 100 images of up to 2 MB
and a 16 MB publication request. Documents retain the normal 5,000-unit layer
dimension ceiling. Oversized selections fail explicitly; choose fewer pages.
Published documents are bounded at 10 MB and pass the existing authorization,
asset quota and staged commit services. File publication uses one bounded staging
write rather than repeatedly rewriting a growing JSONB row. Off-screen free
frames use cached rendered overflow bounds for canvas culling; fonts and edits
invalidate those bounds conservatively.

For a database-free local prototype, run the web development server and open
`/dev/figma-import`. Use the Files creation menu to import a `.fig`, then open
the editor to paste native Figma elements.
The current draft, edits and image bytes are retained automatically in IndexedDB
and restored on reload. This is one local draft per browser origin; importing a
new file replaces it. The prototype route is unavailable in production builds.

Use `bun run test:figma:browser` against a local development server on port 3057
(or set `FIGMA_TEST_BASE_URL`). It checks real keyboard clipboard replay, native
hierarchy, source pixels, component dependency placement, undo/redo and recovery.
`bun run test:figma:publication:browser` uses an existing standalone build and owns
a disposable loopback PostgreSQL cluster. It checks authenticated import,
navigation, reload and access denial. PostgreSQL binaries must be on PATH, and
Node 22.18+ is required for the TypeScript publication runner. Run
`bun run test:files:db` for publication and folder permission regressions.
Optionally set `FIGMA_TEST_FILE` to a private multi-page design-system fixture
with over 5,000 layers to exercise the large-file checks in these suites. Keep it
outside the repository; browser screenshots and logs default to `/tmp`.

