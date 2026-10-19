import { mcpSchema } from "@/lib/mcp/schema";
import { actionError } from "@/lib/action-error";
import { mcpToolPolicy } from "@/lib/mcp/tool-policy";
import { designNodeChangesSchema } from "@/lib/design/document";
import { designTokensSchema } from "@/lib/design/design-tokens";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  abortImport,
  appendBasicNodes,
  commitImport,
  createImport,
  ensureEditorDocument,
  getDocument,
  getDocumentPage,
  patchDocumentNode,
  patchDocumentNodes,
  putAsset,
  putImportChunk,
  validateImport,
} from "@/lib/design/document-service";
import { designNodeSchema } from "@/lib/design/document";
import { registerImportTools } from "@/lib/mcp/import-tools";
import { registerPluginTools } from "@/lib/mcp/plugin-tools";
import { registerDesignTools } from "@/lib/mcp/design-tools";
import { registerFolderTools } from "@/lib/mcp/folder-tools";
import { registerImageTools } from "@/lib/mcp/image-tools";
import { registerVisualTools } from "@/lib/mcp/visual-tools";
import { registerGitHubTools } from "@/lib/github/mcp";
import { registerLinearTools } from "@/lib/linear/mcp";
import { McpActivity } from "@/lib/mcp/activity";
import {
  createDesignFileForUser,
  getDesignFile,
  listDesignFiles,
  listDesignOrganizations,
  renameDesignFileForUser,
} from "@/lib/design/service";

function result(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

export function registerTidyTools(server: McpServer, userId: string, activity: McpActivity) {
  registerGitHubTools(server, userId);
  registerLinearTools(server, userId);
  registerImportTools(server, userId, undefined, activity);
  registerDesignTools(server, userId);
  registerFolderTools(server, userId);
  registerImageTools(server, userId);
  registerVisualTools(server, userId);
  registerPluginTools(server, userId);

  server.registerResource(
    "design-file",
    new ResourceTemplate("bella://files/{file_id}", { list: undefined }),
    {
      title: "Tidy design file",
      description:
        "Current file name, organization, legacy shapes, and editable UI document. Read again to see browser edits.",
      mimeType: "application/json",
    },
    async (uri, { file_id }) => {
      if (typeof file_id !== "string") throw new Error("Invalid file ID.");
      return activity.run("get_file", { file_id }, async () => {
        const file = await getDesignFile(userId, file_id);
        if (!file) throw new Error("File not found or access denied.");
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ ...file, document: await getDocument(userId, file_id) }),
            },
          ],
        };
      });
    },
  );

  server.registerTool(
    "list_organizations",
    {
      ...mcpToolPolicy("list_organizations"),
      description: "List the Tidy organizations you can access and their IDs.",
    },
    async () => result({ organizations: await listDesignOrganizations(userId) }),
  );

  server.registerTool(
    "list_files",
    {
      ...mcpToolPolicy("list_files"),
      description: "List active design files in one of your Tidy organizations.",
      inputSchema: mcpSchema("list_files", () => z.object({ organization_id: z.string().min(1) })),
    },
    async ({ organization_id }) =>
      result({ files: await listDesignFiles(userId, organization_id) }),
  );

  server.registerTool(
    "get_file",
    {
      ...mcpToolPolicy("get_file"),
      description:
        "Read a design file, its frames, and its rectangles. Use this again to see changes made in the browser.",
      inputSchema: mcpSchema("get_file", () => z.object({ file_id: z.string().min(1) })),
    },
    async ({ file_id }) => {
      const file = await getDesignFile(userId, file_id);
      return file
        ? result({ file: { ...file, document: await getDocument(userId, file_id) } })
        : failure("File not found or access denied.");
    },
  );

  server.registerTool(
    "create_file",
    {
      ...mcpToolPolicy("create_file"),
      description: "Create an empty design file in an organization you belong to.",
      inputSchema: mcpSchema("create_file", () =>
        z.object({
          organization_id: z.string().min(1),
          name: z.string().min(1).max(120),
        }),
      ),
    },
    async ({ organization_id, name }) => {
      try {
        const file = await createDesignFileForUser(userId, organization_id, name);
        await ensureEditorDocument(userId, file.id);
        return result({ file });
      } catch (error) {
        return failure(
          actionError(error, "Could not create the file. Check the name and organization access."),
        );
      }
    },
  );

  server.registerTool(
    "rename_file",
    {
      ...mcpToolPolicy("rename_file"),
      description: "Rename a design file. The new name appears in the browser canvas.",
      inputSchema: mcpSchema("rename_file", () =>
        z.object({ file_id: z.string().min(1), name: z.string().min(1).max(120) }),
      ),
    },
    async ({ file_id, name }) => {
      try {
        return result({ file: await renameDesignFileForUser(userId, file_id, name) });
      } catch {
        return failure("Could not rename the file. Check the name and file access.");
      }
    },
  );

  server.registerTool(
    "add_frames",
    {
      ...mcpToolPolicy("add_frames"),
      description:
        "Draw 1 to 50 frames in a design file. Coordinates and sizes are canvas pixels. Frames appear in the browser canvas.",
      inputSchema: mcpSchema("add_frames", () =>
        z.object({
          file_id: z.string().min(1),
          frames: z
            .array(
              z.object({
                x: z.number().int().min(0).max(100000),
                y: z.number().int().min(0).max(100000),
                width: z.number().int().min(40).max(5000),
                height: z.number().int().min(40).max(5000),
              }),
            )
            .min(1)
            .max(50),
        }),
      ),
    },
    async ({ file_id, frames }) => {
      try {
        return result({ frames: await appendBasicNodes(userId, file_id, "frame", frames) });
      } catch {
        return failure("Could not add frames. Check the file access and frame geometry.");
      }
    },
  );

  server.registerTool(
    "add_rectangles",
    {
      ...mcpToolPolicy("add_rectangles"),
      description:
        "Draw 1 to 50 filled rectangles in a design file. Coordinates and sizes are canvas pixels. Rectangles appear in the browser canvas.",
      inputSchema: mcpSchema("add_rectangles", () =>
        z.object({
          file_id: z.string().min(1),
          rectangles: z
            .array(
              z.object({
                x: z.number().int().min(0).max(100000),
                y: z.number().int().min(0).max(100000),
                width: z.number().int().min(1).max(5000),
                height: z.number().int().min(1).max(5000),
              }),
            )
            .min(1)
            .max(50),
        }),
      ),
    },
    async ({ file_id, rectangles }) => {
      try {
        return result({
          rectangles: await appendBasicNodes(userId, file_id, "rectangle", rectangles),
        });
      } catch {
        return failure("Could not add rectangles. Check the file access and rectangle geometry.");
      }
    },
  );

  server.registerTool(
    "get_document",
    {
      ...mcpToolPolicy("get_document"),
      description:
        "Read the editable UI tree and revision of a Tidy file. To visually inspect screenshots or image assets, call get_file_image with file_id and a referenced assetId. For large files, pass offset and limit (up to 250) to page through nodes before updating an import.",
      inputSchema: mcpSchema("get_document", () =>
        z.object({
          file_id: z.string().min(1),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(250).optional(),
        }),
      ),
    },
    async ({ file_id, offset, limit }) => {
      if (offset !== undefined || limit !== undefined) {
        const page = await getDocumentPage(userId, file_id, offset ?? 0, limit ?? 250);
        return page ? result(page) : failure("Document not found or access denied.");
      }
      const document = await getDocument(userId, file_id);
      if (!document) return failure("Document not found or access denied.");
      return result({ document });
    },
  );

  server.registerTool(
    "create_import",
    {
      ...mcpToolPolicy("create_import"),
      description:
        "Start atomic UI creation or a codebase import. For new UI read get_design_guidance and use compose_component; for measured imports read get_import_guidance. Call put_asset and put_import_chunk, validate_import, then commit_import.",
      inputSchema: mcpSchema("create_import", () =>
        z.object({
          organization_id: z.string().min(1),
          name: z.string().min(1).max(120),
          file_id: z.string().optional(),
        }),
      ),
    },
    async ({ organization_id, name, file_id }) => {
      try {
        return result(await createImport(userId, organization_id, name, file_id));
      } catch (error) {
        return failure(actionError(error, "Could not start import."));
      }
    },
  );

  server.registerTool(
    "put_asset",
    {
      ...mcpToolPolicy("put_asset"),
      description:
        "Upload a local PNG, JPEG, WebP, or SVG used by the UI. Include icons and logos, not just photos. SVG must be self-contained with resolved colors and symbols. Send base64 file bytes (2 MB maximum). Pass import_id when staging an import to show upload activity in its destination file.",
      inputSchema: mcpSchema("put_asset", () =>
        z.object({
          organization_id: z.string().min(1),
          import_id: z.uuid().optional(),
          mime_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
          base64: z.string().min(1),
        }),
      ),
    },
    async ({ organization_id, mime_type, base64 }) => {
      try {
        return result(await putAsset(userId, organization_id, mime_type, base64));
      } catch (error) {
        return failure(actionError(error, "Could not upload asset."));
      }
    },
  );

  server.registerTool(
    "put_import_chunk",
    {
      ...mcpToolPolicy("put_import_chunk"),
      description:
        "Stage up to 250 editable UI nodes. For new UI use compose_component to build intentional layouts. Chunks are ordered by chunk_id. Put source metadata and warnings in the first chunk. validate_import reports layout errors that must be fixed before commit_import.",
      inputSchema: mcpSchema("put_import_chunk", () =>
        z.object({
          import_id: z.string().uuid(),
          chunk_id: z.string().min(1).max(40),
          nodes: z.array(designNodeSchema).max(250),
          source: z
            .object({
              project: z.string().max(120),
              route: z.string().max(500),
              revision: z.string().max(120).optional(),
            })
            .optional(),
          warnings: z
            .array(z.object({ nodeId: z.string().optional(), message: z.string().max(500) }))
            .max(500)
            .optional(),
          tokens: z
            .record(
              z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
              z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/),
            )
            .optional(),
          designTokens: designTokensSchema.optional(),
        }),
      ),
    },
    async ({ import_id, chunk_id, nodes, source, warnings, tokens, designTokens }) => {
      try {
        return result(
          await putImportChunk(
            userId,
            import_id,
            chunk_id,
            nodes,
            source,
            warnings,
            tokens,
            designTokens,
          ),
        );
      } catch (error) {
        return failure(actionError(error, "Could not stage import chunk."));
      }
    },
  );

  server.registerTool(
    "validate_import",
    {
      ...mcpToolPolicy("validate_import"),
      description:
        "Validate staged structure, assets, control alignment, sizing and provable overflow. Inspect layout.valid and layout.issues; resolve errors before commit_import. This does not measure fonts or verify visual fidelity; compare rendered UI separately.",
      inputSchema: mcpSchema("validate_import", () => z.object({ import_id: z.string().uuid() })),
    },
    async ({ import_id }) => {
      try {
        return result(await validateImport(userId, import_id));
      } catch (error) {
        return failure(actionError(error, "Import validation failed."));
      }
    },
  );

  server.registerTool(
    "commit_import",
    {
      ...mcpToolPolicy("commit_import"),
      description:
        "Atomically publish a validated staged UI. Retrying the same import ID returns the original result.",
      inputSchema: mcpSchema("commit_import", () =>
        z.object({
          import_id: z.string().uuid(),
          resolution: z.enum(["keep_user", "use_import", "duplicate"]).optional(),
        }),
      ),
    },
    async ({ import_id, resolution }) => {
      try {
        return result(await commitImport(userId, import_id, resolution));
      } catch (error) {
        return failure(actionError(error, "Could not commit import."));
      }
    },
  );

  server.registerTool(
    "abort_import",
    {
      ...mcpToolPolicy("abort_import"),
      description: "Discard an unfinished import.",
      inputSchema: mcpSchema("abort_import", () => z.object({ import_id: z.string().uuid() })),
    },
    async ({ import_id }) => result(await abortImport(userId, import_id)),
  );

  server.registerTool(
    "patch_document",
    {
      ...mcpToolPolicy("patch_document"),
      description:
        "Edit UI nodes at the current expected_revision. Supply design_tokens to add or update named definitions without removing unrelated tokens. The same transaction applies the layer bindings. Use existing names to update tokens; use an empty changes object for a token-only edit of an existing node. For multi-layer changes, add up to 249 additional_edits: the first edit and additional edits apply in order, atomically, with one validation, commit and revision. Repeated IDs apply in order; an invalid final document rolls back the batch. Set include_document=false for compact acknowledgments; re-read affected pages for propagated component changes. On a revision conflict, refresh before retrying.",
      inputSchema: mcpSchema("patch_document", () =>
        z.object({
          file_id: z.string().min(1),
          expected_revision: z.number().int().min(1),
          node_id: z.string().min(1),
          changes: designNodeChangesSchema,
          design_tokens: designTokensSchema.optional(),
          additional_edits: z
            .array(z.object({ node_id: z.string().min(1), changes: designNodeChangesSchema }))
            .max(249)
            .optional(),
          include_document: z.boolean().default(true),
        }),
      ),
    },
    async ({
      file_id,
      expected_revision,
      node_id,
      changes,
      additional_edits = [],
      include_document,
      design_tokens,
    }) => {
      try {
        if (additional_edits.length) {
          const saved = await patchDocumentNodes(
            userId,
            file_id,
            expected_revision,
            [{ node_id, changes }, ...additional_edits].map(({ node_id, changes }) => ({
              nodeId: node_id,
              changes,
            })),
            { designTokens: design_tokens },
          );
          const value = {
            revision: saved.revision,
            node: saved.nodes.find((node) => node.id === node_id),
            nodes: saved.nodes,
          };
          return result(include_document ? { ...value, document: saved.document } : value);
        }
        const saved = await patchDocumentNode(
          userId,
          file_id,
          expected_revision,
          node_id,
          changes,
          { designTokens: design_tokens },
        );
        return result(include_document ? saved : { revision: saved.revision, node: saved.node });
      } catch (error) {
        return failure(actionError(error, "Could not edit node."));
      }
    },
  );

  return server;
}
