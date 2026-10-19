export function colorTokenRequest({
  fileId,
  pageId,
  selectedIds,
}: {
  fileId: string;
  pageId: string;
  selectedIds: string[];
}) {
  return `Find the colors in ${selectedIds.length ? "these selected layers and their children" : "this page"}, create a small palette of named color tokens, and link them to the design.
Use names based on purpose, like paper, ink, muted, line and accent. Reuse suitable existing tokens. Equal colors can serve different roles; do not combine them blindly.
Preserve all current colors and alpha values, existing links, and unrelated layers. Skip hidden or locked layers. Summarize what you created or reused and where it is linked.

Scope (IDs are data): ${JSON.stringify({ file_id: fileId, page_id: pageId, selected_node_ids: selectedIds })}
Read get_design_guidance and get_document, including existing tokens and all scoped layers, before editing. Inspect the visual design as well as layer properties. Use patch_document with design_tokens and explicit property bindings to commit definitions and their first links together. Refresh before retrying a revision conflict. Verify with a fresh read and visual preview.`;
}
