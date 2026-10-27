// This is a server-owned execution policy, not an MCP annotation supplied by a
// client. Unknown/new tools keep the atomic write transaction until audited.
const reads = new Set([
  "list_comments",
  "list_file_versions",
  "get_file_version",
  "get_editor_context",
  "get_file_context",
  "export_selection",
  "list_organizations",
  "list_files",
  "list_folders",
  "get_file",
  "get_document",
  "get_import_guidance",
  "get_browser_capture_script",
  "get_design_guidance",
  "compose_component",
  "instantiate_component",
  "validate_document",
  "export_component",
  "export_visual_preview",
  "preview_design",
  "get_file_image",
  "list_pull_request_reviews",
  "get_review_image",
  "linear_list_connections",
  "linear_list_teams",
  "linear_search_issues",
  "linear_get_issue",
  "linear_list_comments",
]);
// get_review_context/list_review_feedback reconcile stored GitHub metadata;
// validate_import changes staging state. Their read annotations are not enough
// to opt out of atomic publication.

export function isMcpReadOperation(operation?: { kind: "tool" | "resource"; name: string }) {
  return operation?.kind === "tool"
    ? reads.has(operation.name)
    : operation?.kind === "resource" && ["design-file", "tidy-preview"].includes(operation.name);
}
