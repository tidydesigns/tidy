import { requiredMcpScopes } from "./scopes";

const readTools = new Set([
  "list_comments",
  "list_file_versions",
  "get_file_version",
  "get_editor_context",
  "get_file_context",
  "export_selection",
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
const overwriteTools = new Set([
  "patch_document",
  "commit_import",
  "import_web_capture",
  "delete_file",
  "archive_file",
  "delete_comment_thread",
  "edit_comment",
  "delete_page",
  "delete_layers",
  "restore_file_version",
  "reparent_layer",
  "reorder_layer",
  "move_layers_to_page",
  "ungroup_layer",
]);

/** Discovery describes each tool's enforced scopes; annotations are only hints. */
export function mcpToolPolicy(name: string) {
  return {
    annotations: {
      readOnlyHint: readTools.has(name),
      destructiveHint: overwriteTools.has(name),
      openWorldHint: false,
    },
    _meta: {
      securitySchemes: [
        {
          type: "oauth2",
          scopes: [...requiredMcpScopes({ method: "tools/call", params: { name } })],
        },
      ],
    },
  };
}
