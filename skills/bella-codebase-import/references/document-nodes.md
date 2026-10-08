# Bella document nodes

`put_import_chunk` accepts an array of nodes. The full import must include at least one root artboard and no more than 5,000 nodes. Parent IDs must exist, form an acyclic tree of depth at most 40, and point to an artboard or container. Children use coordinates relative to their parent. Artboard positions are canvas coordinates.

Each node needs:

```json
{
  "id": "desktop-sign-in-button",
  "parentId": "desktop-form",
  "name": "Sign in button",
  "type": "container",
  "box": { "x": 0, "y": 386, "width": 384, "height": 48 },
  "style": { "fill": "#ff5d00", "radius": 8 },
  "visible": true,
  "locked": false,
  "layout": "absolute",
  "sourceKey": "desktop:sign-in-button",
  "sourcePath": "components/ui/button.tsx"
}
```

Node types: `artboard`, `container`, `text`, `image`, `vector`. Artboards have `parentId: null`; all other nodes need a parent. Text nodes need a `text` string. Image and vector nodes need an uploaded UUID `assetId`. Include explicit `text` nodes for button labels, field labels, headings, and other copy; a container's name is not rendered as UI text.

`box` values are finite numbers: `x` and `y` between -100,000 and 100,000, `width` and `height` between 1 and 5,000. Use `get_import_guidance` for the current node schema instead of treating this reference as an exhaustive property list. The schema supports paints (solid, linear/radial gradients and images), image crop/position, typography, shadows, 2D rotation and several filters. It does not support arbitrary CSS masks or 3D perspective. Use a rendered asset for unsupported effects and attach node-specific warnings. Never put executable markup in a node.

For measured browser imports, prefer absolute positions with children relative to their parent. `layout` also accepts `flex-row`, `flex-column`, or `grid`; these layouts can reflow in the editor and should only be used when their behavior matches the source.

`sourcePath` must be relative to the checkout and cannot refer to `.env` files or parent paths. `sourceKey` should identify the same visual element across source revisions. Use viewport-specific keys if desktop and mobile nodes are separate. Keep private form values out of text nodes; use source placeholders or an empty field.
