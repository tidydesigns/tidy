---
name: bella-codebase-import
description: Import a rendered website or a screen from a local React or Next.js codebase into an editable Tidy design through MCP, using the agent harness browser to capture and visually validate it.
---

# Import a rendered screen into Tidy

Read the chosen route, its visible components, styles, tokens, and local assets from the engineer's checkout. Bella does not read or execute the repo. Build a static, editable representation of the requested screen at explicit desktop and mobile viewports. Preserve text as text, images as assets, and visual groups as nested containers. Use stable `sourceKey` values so a later import can match the same layers.

Call `get_import_guidance` when available to discover current schemas and fidelity limits. Use the connected Bella MCP tools to discover the organization and target file, stage assets and document chunks, validate, commit, and read the result back. The task is complete when the engineer has a Bella file link, named artboards, editable layers, and an honest list of approximations. If the connected Bella server exposes only legacy `add_frames` and `add_rectangles`, say that the document import tools are unavailable; those shape tools cannot produce an editable UI screen.

## Source to document

1. Resolve the requested route entry and inspect only the components, CSS, Tailwind classes, fonts, and assets that affect its visible state. Prefer a local browser render: wait for fonts and images, pause animation, and record viewport, device scale, scroll and state. Measure rendered bounds and computed styles. When browser access is unavailable, label the result a source-based approximation and flag inferred geometry. Never claim a screenshot was compared when only source or node JSON was checked.
2. Choose viewport dimensions that fit the request. Create one artboard per viewport. Give every node a stable ID and `sourceKey`, a meaningful name, a parent, bounds, and typed style. Keep node IDs and source keys stable across reruns when possible. See [references/document-nodes.md](references/document-nodes.md) for the accepted model.
3. Inventory images, logos, inline SVG/icon components, CSS backgrounds and generated content. Upload local images and self-contained SVG icons through `put_asset`. Resolve SVG `currentColor`, inherited styles and referenced symbols; preserve the viewBox. Do not substitute Unicode for icons or silently omit them. Do not import environment files, credentials, private autofill, API responses, or absolute local paths. Use a representative static state for dynamic data and interactions, and attach warnings for omissions or approximations.

## Fidelity and browser captures

For masks, 3D transforms and other effects outside the node schema, preserve the smallest complete visual group as a rendered image and attach a warning naming the layer and effect. Keep surrounding text and controls editable. A raw image does not preserve a CSS forest fade or laptop perspective. Do not render the flattened descendants again. Screenshot crops bake in backgrounds and overlapping content: use isolated transparent assets where possible, or report that the composite was flattened. Sanitize form values before any screenshot fallback.

For a rendered page, call `get_browser_capture_script` and execute its self-contained script in the user's agent harness browser. No Tidy extension is required. The extension uses the same capture engine. Follow [references/browser-capture.md](references/browser-capture.md) for the prepare/screenshot/capture API and a Playwright example. Use the original website or a locally running route as the source; do not manually reconstruct it from JSX when a rendered browser is available.

The engine measures layout, imports icons and images, isolates supported masked groups into transparent raster assets, and flattens perspective groups from the supplied viewport screenshot. It excludes private form values and reports unavailable resources, redactions, flattening and offscreen clipping. These are raster fallbacks, not editable CSS masks or 3D layers. Bring complete perspective groups into view before capture.

Submit the returned capture to `import_web_capture`. It creates a new copy on every invocation, including when targeting an existing file. After a timeout, inspect the destination before retrying. Prefer the staged tools below for large payloads, updates and retry-safe publishing. The server never opens the source URL: browser execution and visual verification belong to the agent harness.

## MCP publish sequence

1. Call `list_organizations` and, for an update, `get_document` on the target file. Upload each needed asset with `put_asset` and use the returned asset IDs in image or vector nodes.
2. Call `create_import` with the organization ID, file name, and optional existing file ID. For a new file, let `commit_import` create it atomically; avoid a separate empty `create_file` call.
3. Send ordered chunks of at most 250 nodes using `put_import_chunk`. Put `{project, route, revision}` source metadata and warnings in the first chunk. Use retry-stable chunk IDs. Call `validate_import`; fix errors before publishing.
4. Call `commit_import`. For an update, a revision mismatch means the file changed: read the latest document and begin a new import. If Bella reports manual-edit conflicts, use `keep_user` unless the engineer requested an overwrite, and report the affected layers. Retry a timed-out commit using the same import ID; it is idempotent.
5. Call `get_document` to verify the committed revision, artboards, node count, and assets. Then compare the rendered Tidy artboards against the rendered source at matching viewport/state. Check asset completeness (especially icons), font wrapping, geometry, crop, masks and transformed composites. Fix visible mismatches before calling the import finished. `validate_import` and `get_document` verify structure, not appearance. If browser comparison is unavailable, explicitly mark the result visually unverified. Return the file URL, captured viewports/state, editable versus flattened layers, missing assets/fonts, and remaining differences. If staging cannot be completed, call `abort_import`.

The user's request to import into Bella authorizes file creation or updates through Bella MCP. It does not authorize database migrations, credential changes, deployment, or access beyond the chosen codebase and organization.
