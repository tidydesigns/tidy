import "server-only";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PoolClient } from "pg";
import { registerTidyTools } from "@/lib/mcp/registry";
import { McpActivity } from "@/lib/mcp/activity";
import { resolveActivityScope } from "@/lib/mcp/activity-scope";
import { publishAgentActivity } from "@/lib/realtime/server";
import { AgentError, type StartRun } from "./protocol";
import type { DynamicTool } from "./execution-protocol";

type ToolResult = {
  content?: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Registration = { description?: string; inputSchema?: z.ZodType };
type Handler = (input: Record<string, unknown>) => Promise<ToolResult>;
// Attached-file tools share the public MCP registry. Organisation management
// requires an explicit scope extension in the composer. The current GitHub MCP
// tools write local review data; none post comments or push code externally.
const scopedTools = new Set([
  "list_organizations",
  "list_files",
  "list_folders",
  "get_file",
  "get_document",
  "get_file_image",
  "rename_file",
  "add_frames",
  "add_rectangles",
  "get_design_guidance",
  "compose_component",
  "instantiate_component",
  "validate_document",
  "export_component",
  "export_visual_preview",
  "get_import_guidance",
  "get_browser_capture_script",
  "create_import",
  "put_asset",
  "put_import_chunk",
  "validate_import",
  "commit_import",
  "abort_import",
  "import_web_capture",
  "patch_document",
  "list_pull_request_reviews",
  "get_review_context",
  "list_review_feedback",
  "get_review_image",
  "link_pull_request",
  "upload_implementation_capture",
  "add_review_feedback",
  "record_feedback_response",
]);
const organizationTools = new Set([
  "create_file",
  "create_folder",
  "rename_folder",
  "delete_folder",
  "move_file",
]);

export function agentTools(
  userId: string,
  agentId: string,
  label: string,
  threadId?: string,
  ownerName?: string,
  allowOrganizationChanges = false,
) {
  const handlers = new Map<string, { schema: z.ZodType; handler: Handler }>();
  const tools: DynamicTool[] = [];
  const activity = new McpActivity(
    {
      userId,
      clientId: `tidy-agent:${agentId}`,
      agentId,
      threadId,
      ownerName: ownerName?.slice(0, 80),
    },
    {
      resolve: resolveActivityScope,
      publish: publishAgentActivity,
      name: async () => label,
    },
  );
  const collector = {
    registerResource: () => {},
    registerTool(name: string, config: Registration, handler: Handler) {
      if (!scopedTools.has(name) && !(allowOrganizationChanges && organizationTools.has(name)))
        return;
      const schema = config.inputSchema ?? z.object({});
      handlers.set(name, { schema, handler });
      tools.push({
        type: "function",
        name,
        description: config.description ?? name,
        inputSchema: z.toJSONSchema(schema, {
          target: "draft-7",
          unrepresentable: "any",
        }) as Record<string, unknown>,
      });
    },
  };
  registerTidyTools(collector as unknown as McpServer, userId, activity);
  return {
    tools,
    activity,
    async invoke(name: string, input: Record<string, unknown>) {
      const tool = handlers.get(name);
      if (!tool)
        throw new AgentError("tool_denied", "This tool is outside this run's canvas scope.", 403);
      return tool.handler(tool.schema.parse(input) as Record<string, unknown>);
    },
  };
}

export async function checkToolScope(
  client: PoolClient,
  userId: string,
  organizationId: string,
  files: StartRun["files"],
  tool: string,
  input: Record<string, unknown>,
  runId: string,
  allowOrganizationChanges = false,
) {
  if (!scopedTools.has(tool) && !(allowOrganizationChanges && organizationTools.has(tool)))
    throw new AgentError("tool_denied", "This tool is outside this run's canvas scope.", 403);
  if (input.organization_id !== undefined && input.organization_id !== organizationId)
    throw new AgentError("scope_denied", "This run is scoped to another organisation.", 403);
  const permitted = new Set(files.map((file) => file.id));
  if (input.file_id !== undefined && !permitted.has(String(input.file_id)))
    throw new AgentError("scope_denied", "Attach this file before asking agents to use it.", 403);
  if (
    ["create_import", "import_web_capture"].includes(tool) &&
    !input.file_id &&
    !allowOrganizationChanges
  )
    throw new AgentError("scope_denied", "Import into an attached file.", 403);
  if (input.import_id) {
    const row = (
      await client.query<{ fileId: string }>(
        `select "fileId" from "designImport" where "id"=$1 and "userId"=$2 and "organizationId"=$3 for share`,
        [input.import_id, userId, organizationId],
      )
    ).rows[0];
    const ownCreation =
      !row?.fileId &&
      allowOrganizationChanges &&
      (
        await client.query(
          `select 1 from "agentToolOperation" where "runId"=$1 and "tool"='create_import' and "result"->'structuredContent'->>'importId'=$2`,
          [runId, input.import_id],
        )
      ).rowCount;
    if (!row || (!permitted.has(row.fileId) && !ownCreation))
      throw new AgentError("scope_denied", "Import is outside this run.", 403);
  }
  if (input.folder_id) {
    const folder = await client.query(
      `select 1 from "designFolder" where "id"=$1 and "organizationId"=$2 for share`,
      [input.folder_id, organizationId],
    );
    if (!folder.rowCount)
      throw new AgentError("scope_denied", "Folder is outside this organisation.", 403);
  }
  if (input.review_id) {
    const row = (
      await client.query<{ fileId: string }>(
        `select "fileId" from "githubReview" where "id"=$1 for share`,
        [input.review_id],
      )
    ).rows[0];
    if (!row || !permitted.has(row.fileId))
      throw new AgentError("scope_denied", "Review is outside this run.", 403);
  }
  if (tool === "commit_import" && input.resolution === "use_import")
    throw new AgentError(
      "conflict",
      "Preserve human edits. Re-read and reconcile the import instead of replacing them.",
      409,
    );
}

export function filterDiscovery(
  result: ToolResult,
  tool: string,
  organizationId: string,
  files: StartRun["files"],
) {
  if (!result.structuredContent || !["list_organizations", "list_files"].includes(tool))
    return result;
  const key = tool === "list_files" ? "files" : "organizations";
  const allowed = new Set(tool === "list_files" ? files.map((file) => file.id) : [organizationId]);
  const list = result.structuredContent[key];
  const value = {
    [key]: Array.isArray(list)
      ? list.filter((row) => row && typeof row === "object" && allowed.has(row.id))
      : [],
  };
  return {
    ...result,
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}
