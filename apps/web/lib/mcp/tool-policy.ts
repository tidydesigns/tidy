const readTools = new Set([
  "list_organizations",
  "list_files",
  "get_file",
  "get_document",
  "get_design_guidance",
  "compose_component",
  "instantiate_component",
  "validate_document",
  "export_component",
  "export_visual_preview",
  "get_import_guidance",
  "get_browser_capture_script",
  "validate_import",
  "list_pull_request_reviews",
  "get_review_context",
  "list_review_feedback",
  "get_review_image",
  "preview_design",
]);
const overwriteTools = new Set(["patch_document", "commit_import", "import_web_capture"]);

/** This endpoint currently requires both scopes, including for reads. Match its actual auth contract. */
export function mcpToolPolicy(name: string) {
  return {
    annotations: {
      readOnlyHint: readTools.has(name),
      destructiveHint: overwriteTools.has(name),
      openWorldHint: false,
    },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mcp:read", "mcp:write"] }] },
  };
}
