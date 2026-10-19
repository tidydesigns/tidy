# Canvas artboard labels

Canvas titles and Layers rows identify the same artboard. Tidy stores one name
on the existing node; selection, renaming, visibility and locking operate on that
node. The title is editor UI above the artwork, rather than a text layer inside
it. This implements the relationship shown in the supplied Paper screenshots.

## Paper and Figma

Paper's screenshots show a repeated name above each design and on its parent
row in Layers. That establishes the visible relationship; it does not reveal
Paper's private rendering or storage implementation.

Paper documents frames and flex layouts as containers, parent/child selection,
sibling navigation, layer renaming, visibility and locks. Its HTML import accepts
`layer-name` as a layer label and retains nested editable structure. Its MCP
guide recommends structuring designs with containers and flex layouts for code
handoff. The underlying methodology is to make the design hierarchy meaningful
for editing and implementation, rather than using flat screenshots.

Sources: [Paper selection and hierarchy](https://paper.design/docs/support),
[HTML import](https://paper.design/docs/paste/html),
[Paper code handoff](https://paper.design/docs/mcp#building-a-website-from-a-design).

Figma explicitly displays top-level frame names on the canvas and emphasizes
those frames in Layers. Frames can nest and provide layout, clipping and
constraints. Groups combine objects; sections organize regions of the file.
Sections can contain frames and other sections, but cannot live inside frames
or groups. A section is therefore a distinct structural concept, not another
name for every screen's title. Figma supports renaming a section through its
canvas title or Layers row.

Sources: [Figma frames](https://help.figma.com/hc/en-us/articles/360041539473-Frames-in-Figma-Design),
[Figma sections](https://help.figma.com/hc/en-us/articles/9771500257687-Organize-your-canvas-with-sections),
[Figma containers and hierarchy](https://help.figma.com/hc/en-us/articles/15297425105303-Explore-design-files).

Figma's public node API exposes identity, name, parent and children on its scene
graph. Sharing identity between multiple UI views is the relevant architectural
principle for Tidy. The screen-space label treatment below is our implementation
choice; public product behavior does not establish either vendor's internal
rendering algorithm.

Sources: [Figma parent property](https://developers.figma.com/docs/plugins/api/properties/nodes-parent/),
[Figma SectionNode](https://developers.figma.com/docs/plugins/api/SectionNode/).

## Tidy architecture

The web editor uses Next.js 16 and React 19. Browser-safe document schemas live
in `packages/design`, with runtime validation through Zod and inferred domain
types. Nodes already have stable IDs, names, parent IDs, page membership, bounds,
visibility and locks. `artboard` is the existing screen container type.

`CanvasArtwork` renders the scene as HTML/CSS. The editor indexes nodes and child
lists, memoizes branches and culls distant artboards. The Layers tree reads those
same nodes and selected IDs, with virtualization for large documents.

`changeDocument` validates transactions, calculates document patches and routes
them through the edit queue. Local previews apply the same patches in memory;
authenticated files send them to the changes endpoint. The server commits the
revision, JSONB document and durable edit events in Postgres. Existing history
and conditional undo handle name changes without introducing a second API.

## Implementation

- Render titles only for visible, mounted, top-level artboards on the current
  page. Ordinary text, shapes and nested containers do not receive titles.
- Keep titles outside `CanvasArtwork` and its registered node elements. They
  cannot affect artboard layout, clipping, artwork bounds or exported content.
- Position titles above their artboards and counter-scale their UI against the
  canvas zoom. Limit each title to its artboard's screen width and truncate long
  names, retaining the full name in the tooltip.
- Click to select the existing ID; Shift-click uses the existing additive
  selection behavior. Layer selection updates the canvas title's selected state.
- Double-click to rename. Enter or blur commits; Escape cancels; empty names
  leave the existing name intact. Respect the schema's 120-character limit.
- Use `changedLayers` and `changeDocument` so component rules, locks, validation,
  optimistic updates, history and persistence match inspector edits.
- Allow viewers to select, while disabling renaming for viewers, locked nodes
  and nodes supplied by a component library. Omit titles in prototype mode.
- Emphasize top-level artboards in Layers to make the hierarchy easier to scan.

No migration, new dependency, duplicated label state in the document, or new
container type is needed. Rename drafts are temporary UI state; the canonical
name remains `DesignNode.name`.

## Scope

This implements named artboard headers. A future Figma-style section container
would require its own schema and semantics: allowed nesting, automatic capture
or reparenting, relative coordinates, resizing, clipping, ordering, selection,
copy/paste, import/export and collaboration rules. Adding a title does not
require those changes, and this feature does not introduce them.

The browser regression suite is `apps/web/tests/browser/artboard-labels.e2e.ts`.
It covers shared selection and names, undo, cancelled and empty renames, zoom
geometry, visibility, locks and viewer access. The existing Postgres command
integration suite exercises durable name edits and conditional undo.

Verified locally on 2026-10-19: workspace typecheck and lint, 1,146 unit tests
(with 735 environment-dependent skips), four browser regressions and 22
Postgres command integration tests passed. An authenticated browser rename
advanced the disposable database to revision 2 and survived a full page reload.
The full workspace production build passed with `WXT_BELLA_URL=https://example.test`
for the extension artifact. Browser tests used installed Chrome after bundled
Chromium's font service reported a disk quota error. Live room broadcast was
not exercised; persistence was verified through the real HTTP changes endpoint.
