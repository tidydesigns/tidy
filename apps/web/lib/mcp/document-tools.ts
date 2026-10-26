import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { randomUUID } from "node:crypto";
import { editDocumentStructure } from "@/lib/design/document-service";
import { documentPages, duplicatePage, deletePage } from "@/lib/design/pages";
import { duplicateLayers, isLayerLocked, selectionRoots } from "@/lib/design/edit-document";
import {
  removeLayers,
  reparentLayer,
  relocateLayer,
  moveLayer,
} from "@tidy/editor/design/document-operations";
import { wrapLayers, unwrapLayer } from "@tidy/editor/design/layout-operations";
import { componentSubtreeIds } from "@tidy/editor/design/component-variants";
import { designNodeSchema, nodePageId, type DesignDocument } from "@/lib/design/document";
import { PublicActionError } from "@/lib/security/public-error";
import { mcpSchema } from "./schema";
import { mcpToolPolicy } from "./tool-policy";
import { toolOperation } from "./tool-result";
const id = z.string().min(1).max(120);
const base = { file_id: id, expected_revision: z.number().int().min(1).max(2147483646) };
const ids = z
  .array(id)
  .min(1)
  .max(250)
  .refine((v) => new Set(v).size === v.length, "Choose each layer once.");
function requireLayers(document: DesignDocument, ids: string[]) {
  if (ids.some((id) => !document.nodes.some((node) => node.id === id)))
    throw new PublicActionError("Layer not found. Refresh before editing.");
}
export function registerDocumentTools(server: McpServer, userId: string) {
  server.registerTool(
    "rename_page",
    {
      ...mcpToolPolicy("rename_page"),
      description: "Rename a page at expected_revision without changing its layers.",
      inputSchema: mcpSchema("rename_page", () =>
        z.object({ ...base, page_id: id, name: z.string().trim().min(1).max(120) }),
      ),
    },
    ({ file_id, expected_revision, page_id, name }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            if (!documentPages(document).some((p) => p.id === page_id))
              throw new PublicActionError("Page not found.");
            return {
              document: {
                ...document,
                pages: documentPages(document).map((p) => (p.id === page_id ? { ...p, name } : p)),
              },
              result: { pageId: page_id, name },
            };
          }),
        "Could not rename the page.",
      ),
  );
  server.registerTool(
    "reorder_page",
    {
      ...mcpToolPolicy("reorder_page"),
      description: "Move a page to a zero-based index at expected_revision.",
      inputSchema: mcpSchema("reorder_page", () =>
        z.object({ ...base, page_id: id, index: z.number().int().min(0).max(99) }),
      ),
    },
    ({ file_id, expected_revision, page_id, index }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            const pages = [...documentPages(document)],
              previous = pages.findIndex((p) => p.id === page_id);
            if (previous < 0 || index >= pages.length)
              throw new PublicActionError("Page or position not found.");
            const [page] = pages.splice(previous, 1);
            pages.splice(index, 0, page);
            return { document: { ...document, pages }, result: { pages } };
          }),
        "Could not reorder the page.",
      ),
  );
  server.registerTool(
    "duplicate_page",
    {
      ...mcpToolPolicy("duplicate_page"),
      description:
        "Duplicate a page and its layers, preserving internal references with new IDs. Comments are not duplicated. Returns the new page and root IDs.",
      inputSchema: mcpSchema("duplicate_page", () => z.object({ ...base, page_id: id })),
    },
    ({ file_id, expected_revision, page_id }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            if (!documentPages(document).some((p) => p.id === page_id))
              throw new PublicActionError("Page not found.");
            if (documentPages(document).length >= 100)
              throw new PublicActionError("A file can contain up to 100 pages.");
            const pageId = randomUUID(),
              copied = duplicatePage(document, page_id, pageId, randomUUID);
            return {
              document: copied,
              result: {
                page: documentPages(copied).find((p) => p.id === pageId)!,
                nodeIds: copied.nodes
                  .filter((n) => nodePageId(n) === pageId && !n.parentId)
                  .map((n) => n.id),
              },
            };
          }),
        "Could not duplicate the page.",
      ),
  );
  server.registerTool(
    "delete_page",
    {
      ...mcpToolPolicy("delete_page"),
      description:
        "Delete a page and all its layers. A file must retain at least one page. Comment threads are retained with their original page ownership.",
      inputSchema: mcpSchema("delete_page", () => z.object({ ...base, page_id: id })),
    },
    ({ file_id, expected_revision, page_id }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            if (!documentPages(document).some((p) => p.id === page_id))
              throw new PublicActionError("Page not found.");
            if (documentPages(document).length <= 1)
              throw new PublicActionError("A file must retain at least one page.");
            return { document: deletePage(document, page_id), result: { deleted: true } };
          }),
        "Could not delete the page.",
      ),
  );
  server.registerTool(
    "insert_nodes",
    {
      ...mcpToolPolicy("insert_nodes"),
      description:
        "Insert up to 250 complete editable nodes on an existing page at expected_revision. Nodes may reference each other or existing parents on that page. IDs must be new; all hierarchy, assets and document limits are validated atomically. Use compose_component for layout-first authoring.",
      inputSchema: mcpSchema("insert_nodes", () =>
        z.object({ ...base, page_id: id, nodes: z.array(designNodeSchema).min(1).max(250) }),
      ),
    },
    ({ file_id, expected_revision, page_id, nodes }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            if (!documentPages(document).some((p) => p.id === page_id))
              throw new PublicActionError("Page not found.");
            const existing = new Set(document.nodes.map((n) => n.id));
            if (nodes.some((n) => existing.has(n.id)))
              throw new PublicActionError("Layer IDs must be new.");
            if (
              nodes.some(
                (n) =>
                  n.parentId &&
                  document.nodes.some(
                    (p) => p.id === n.parentId && isLayerLocked(document.nodes, p.id),
                  ),
              )
            )
              throw new PublicActionError("Unlock the destination before inserting layers.");
            return {
              document: {
                ...document,
                nodes: [...document.nodes, ...nodes.map((n) => ({ ...n, pageId: page_id }))],
              },
              result: { nodeIds: nodes.map((n) => n.id) },
            };
          }),
        "Could not insert layers.",
      ),
  );
  server.registerTool(
    "delete_layers",
    {
      ...mcpToolPolicy("delete_layers"),
      description:
        "Delete selected unlocked layers and their descendants. Component references, masks and import-deletion history are reconciled.",
      inputSchema: mcpSchema("delete_layers", () => z.object({ ...base, node_ids: ids })),
    },
    ({ file_id, expected_revision, node_ids }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            requireLayers(document, node_ids);
            return { document: removeLayers(document, node_ids), result: { deletedIds: node_ids } };
          }),
        "Could not delete layers.",
      ),
  );
  server.registerTool(
    "duplicate_layers",
    {
      ...mcpToolPolicy("duplicate_layers"),
      description:
        "Duplicate unlocked layers and their descendants with new IDs, using the editor's placement and reference-remapping rules.",
      inputSchema: mcpSchema("duplicate_layers", () => z.object({ ...base, node_ids: ids })),
    },
    ({ file_id, expected_revision, node_ids }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            requireLayers(document, node_ids);
            if (node_ids.some((id) => isLayerLocked(document.nodes, id)))
              throw new PublicActionError("Unlock selected layers before duplicating them.");
            const result = duplicateLayers(document, node_ids, randomUUID);
            return { document: result.document, result: { nodeIds: result.ids } };
          }),
        "Could not duplicate layers.",
      ),
  );
  server.registerTool(
    "reparent_layer",
    {
      ...mcpToolPolicy("reparent_layer"),
      description:
        "Move an unlocked layer into a container/frame on the same page, or to the canvas with parent_id=null. Preserves stored geometry; flow layouts may need a visual check.",
      inputSchema: mcpSchema("reparent_layer", () =>
        z.object({ ...base, node_id: id, parent_id: id.nullable() }),
      ),
    },
    ({ file_id, expected_revision, node_id, parent_id }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => ({
            document: reparentLayer(document, node_id, parent_id),
            result: { nodeId: node_id, parentId: parent_id },
          })),
        "Could not reparent the layer.",
      ),
  );
  server.registerTool(
    "reorder_layer",
    {
      ...mcpToolPolicy("reorder_layer"),
      description:
        "Move an unlocked layer one sibling position using direction, or before/inside/after a target layer on the same page. Uses the editor's hierarchy and geometry rules.",
      inputSchema: mcpSchema("reorder_layer", () =>
        z.object({
          ...base,
          node_id: id,
          destination: z.union([
            z.object({ direction: z.union([z.literal(-1), z.literal(1)]) }),
            z.object({ target_id: id, position: z.enum(["before", "inside", "after"]) }),
          ]),
        }),
      ),
    },
    ({ file_id, expected_revision, node_id, destination }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            requireLayers(document, [node_id]);
            return {
              document:
                "direction" in destination
                  ? moveLayer(document, node_id, destination.direction)
                  : relocateLayer(document, node_id, destination.target_id, destination.position),
              result: { nodeId: node_id },
            };
          }),
        "Could not reorder the layer.",
      ),
  );
  server.registerTool(
    "group_layers",
    {
      ...mcpToolPolicy("group_layers"),
      description:
        "Wrap unlocked sibling layers in a group, frame or auto-layout container using stored geometry. Returns the wrapper ID.",
      inputSchema: mcpSchema("group_layers", () =>
        z.object({
          ...base,
          node_ids: ids,
          kind: z.enum(["group", "frame", "auto"]).default("group"),
        }),
      ),
    },
    ({ file_id, expected_revision, node_ids, kind }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            requireLayers(document, node_ids);
            const result = wrapLayers(document, node_ids, randomUUID(), kind);
            return { document: result.document, result: { nodeId: result.id } };
          }),
        "Could not group layers.",
      ),
  );
  server.registerTool(
    "ungroup_layer",
    {
      ...mcpToolPolicy("ungroup_layer"),
      description:
        "Remove an unlocked wrapper while preserving its children using the editor's geometry rules.",
      inputSchema: mcpSchema("ungroup_layer", () => z.object({ ...base, node_id: id })),
    },
    ({ file_id, expected_revision, node_id }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            requireLayers(document, [node_id]);
            return { document: unwrapLayer(document, node_id), result: { ungrouped: true } };
          }),
        "Could not ungroup the layer.",
      ),
  );
  server.registerTool(
    "move_layers_to_page",
    {
      ...mcpToolPolicy("move_layers_to_page"),
      description:
        "Move selected unlocked layer trees to another page, detaching them to that page's canvas. Preserves IDs and subtree content; validation rejects invalid cross-page relationships.",
      inputSchema: mcpSchema("move_layers_to_page", () =>
        z.object({ ...base, node_ids: ids, page_id: id }),
      ),
    },
    ({ file_id, expected_revision, node_ids, page_id }) =>
      toolOperation(
        () =>
          editDocumentStructure(userId, file_id, expected_revision, (document) => {
            requireLayers(document, node_ids);
            if (!documentPages(document).some((p) => p.id === page_id))
              throw new PublicActionError("Page not found.");
            if (node_ids.some((id) => isLayerLocked(document.nodes, id)))
              throw new PublicActionError("Unlock selected layers before moving them.");
            const roots = new Set(selectionRoots(document.nodes, node_ids).map((n) => n.id)),
              moved = new Set(
                [...roots].flatMap((id) => [...componentSubtreeIds(document.nodes, id)]),
              );
            let changed = document;
            for (const id of roots) {
              const node = changed.nodes.find((n) => n.id === id)!;
              if (node.parentId) changed = reparentLayer(changed, id, null);
            }
            return {
              document: {
                ...changed,
                nodes: changed.nodes.map((n) => (moved.has(n.id) ? { ...n, pageId: page_id } : n)),
              },
              result: { nodeIds: [...roots], pageId: page_id },
            };
          }),
        "Could not move layers to the page.",
      ),
  );
}
