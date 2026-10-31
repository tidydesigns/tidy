import { CloudComputeBusyError } from "../cloud/cloud-compute-errors";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { resolvedDocumentNodes } from "@tidy/design/design-tokens";
import {
  designNodeSchema,
  designNodeChangesSchema,
  documentAssetIds,
  buildDrawnNode,
  nodePageId,
  parseDesignDocument,
  type DesignDocument,
} from "@tidy/design/document";
import {
  duplicateLayers,
  changedLayerBatch,
  isLayerLocked,
  trackDocumentChanges,
} from "@tidy/editor/design/edit-document";
import {
  alignLayers,
  distributeLayers,
  moveLayer,
  removeLayers,
  reparentLayer,
} from "@tidy/editor/design/document-operations";
import { wrapLayers, unwrapLayer } from "@tidy/editor/design/layout-operations";
import {
  applyDocumentPatch,
  diffDocument,
  documentPatchSchema,
  invertPatch,
  type DocumentPatch,
} from "@tidy/editor/design/document-patch";
import type { ProjectStore } from "../workspace/project-store";
import { AgentOperationError, type AgentScope } from "./contracts";

const entityId = z.string().min(1).max(120);
const nodeIds = z.array(entityId).min(1).max(100);
const version = z.string().min(1).max(256);
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 128 * 1024;
const compactStyleSchema = designNodeChangesSchema.shape.style.unwrap().pick({
  fill: true,
  color: true,
  borderColor: true,
  borderWidth: true,
  radius: true,
  fontFamily: true,
  fontSize: true,
  fontWeight: true,
  lineHeight: true,
  textAlign: true,
  opacity: true,
});
const compactChangesSchema = designNodeChangesSchema
  .pick({
    name: true,
    text: true,
    visible: true,
    locked: true,
    box: true,
    layout: true,
    positionMode: true,
    widthMode: true,
    heightMode: true,
    align: true,
    justify: true,
    gap: true,
    padding: true,
    paddingTop: true,
    paddingRight: true,
    paddingBottom: true,
    paddingLeft: true,
  })
  .extend({ style: compactStyleSchema.optional() })
  .strict();
const authorNodeSchema = compactChangesSchema
  .extend({
    id: entityId,
    name: entityId,
    parentId: entityId.nullable(),
    pageId: entityId.optional(),
    type: z.enum(["artboard", "container", "text"]),
  })
  .strict();

export const canvasReadSchema = z
  .object({
    design_id: z.uuid(),
    node_ids: nodeIds.optional(),
    page_id: entityId.optional(),
    query: z.string().max(200).default(""),
    descendants: z.boolean().default(false),
    detail: z.enum(["summary", "full"]).default("summary"),
    include_tokens: z.boolean().default(false),
    token_offset: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .default(0)
      .describe(
        "Offset across tokens, designTokens, then reusableStyles. Continue with next_token_offset and expected_version.",
      ),
    token_limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(100)
      .describe("Maximum combined token/style entries. The byte budget may return fewer."),
    page_offset: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(0)
      .describe("Continue page metadata with next_page_offset and expected_version."),
    page_limit: z.number().int().min(1).max(100).default(100),
    expected_version: version.optional(),
    offset: z
      .number()
      .int()
      .min(0)
      .max(50000)
      .default(0)
      .describe("Continue nodes with next_offset and expected_version."),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict()
  .refine(
    (request) =>
      (!request.offset && !request.token_offset && !request.page_offset) ||
      request.expected_version !== undefined,
    "Provide expected_version when continuing node, token or page reads.",
  );

type CanvasTokenEntry =
  | { kind: "tokens"; key: string; value: DesignDocument["tokens"][string] }
  | {
      kind: "designTokens";
      key: string;
      value: NonNullable<DesignDocument["designTokens"]>[string];
    }
  | {
      kind: "reusableStyles";
      key: string;
      value: NonNullable<DesignDocument["reusableStyles"]>[string];
    };

function* tokenEntries(document: DesignDocument): Generator<CanvasTokenEntry> {
  for (const [key, value] of Object.entries(document.tokens)) yield { kind: "tokens", key, value };
  for (const [key, value] of Object.entries(document.designTokens ?? {}))
    yield { kind: "designTokens", key, value };
  for (const [key, value] of Object.entries(document.reusableStyles ?? {}))
    yield { kind: "reusableStyles", key, value };
}

function boundedPage<T>({
  items,
  offset,
  limit,
  budget,
  oversized,
}: {
  items: Iterable<T>;
  offset: number;
  limit: number;
  budget: number;
  oversized: string;
}) {
  const result: T[] = [];
  let index = 0;
  let bytes = 2;
  for (const item of items) {
    if (index++ < offset) continue;
    if (result.length === limit) break;
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > budget) {
      if (!result.length) throw new AgentOperationError("BUSY", oversized);
      break;
    }
    bytes += size;
    result.push(item);
  }
  return result;
}

export const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("undo"), request_id: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("update"),
      node_ids: nodeIds,
      changes: compactChangesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("add"),
      nodes: z.array(authorNodeSchema).min(1).max(100),
    })
    .strict(),
  z.object({ kind: z.literal("delete"), node_ids: nodeIds }).strict(),
  z.object({ kind: z.literal("duplicate"), node_ids: nodeIds }).strict(),
  z
    .object({
      kind: z.literal("group"),
      node_ids: nodeIds,
      layout: z.enum(["group", "frame", "auto"]).default("group"),
    })
    .strict(),
  z.object({ kind: z.literal("ungroup"), node_id: entityId }).strict(),
  z
    .object({
      kind: z.literal("reparent"),
      node_id: entityId,
      parent_id: entityId.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reorder"),
      node_id: entityId,
      direction: z.union([z.literal(-1), z.literal(1)]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("align"),
      node_ids: nodeIds,
      axis: z.enum(["left", "center-x", "right", "top", "center-y", "bottom"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("distribute"),
      node_ids: nodeIds,
      axis: z.enum(["horizontal", "vertical"]),
    })
    .strict(),
]);
export const canvasEditSchema = z
  .object({
    design_id: z.uuid(),
    expected_version: version,
    request_id: z.uuid(),
    operations: z.array(operationSchema).min(1).max(32),
  })
  .strict()
  .refine(
    (request) =>
      !request.operations.some((operation) => operation.kind === "undo") ||
      request.operations.length === 1,
    "Undo must be the only operation in a transaction.",
  );
export const canvasRenderSchema = z
  .object({
    design_id: z.uuid(),
    expected_version: version,
    node_id: entityId,
  })
  .strict();

const editResultSchema = z
  .object({
    design_id: z.uuid(),
    version,
    request_id: z.uuid(),
    created_node_ids: z.array(entityId).max(1000),
    undo_available: z.literal(true),
  })
  .strict();
const receiptOwnerSchema = z
  .object({ project_id: z.uuid(), thread_id: z.uuid(), design_id: z.uuid() })
  .strict();
const receiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pending"),
      fingerprint: z.string(),
      owner: receiptOwnerSchema,
      patch: documentPatchSchema,
      inverse: documentPatchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("complete"),
      fingerprint: z.string(),
      owner: receiptOwnerSchema,
      result: editResultSchema,
      patch: documentPatchSchema,
      inverse: documentPatchSchema,
    })
    .strict(),
]);
export type CanvasSnapshot = {
  document: DesignDocument;
  rootId: string;
  projectId: string;
  designId: string;
  version: string;
  signal: AbortSignal;
  assets: Record<string, string>;
  width: number;
  warnings: string[];
};
export type CanvasRenderResult = {
  kind: "rendered";
  mime_type: "image/png";
  data: string;
  width: number;
  height: number;
  limitations: string[];
};
export type CanvasReceipts = {
  read(key: string): Promise<unknown | undefined>;
  write(key: string, value: unknown): Promise<void>;
};
export type CanvasOperations = z.infer<typeof operationSchema>[];

function requireNodes(document: DesignDocument, ids: string[]) {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  for (const id of ids)
    if (!nodes.has(id)) throw new AgentOperationError("NOT_FOUND", `Layer not found: ${id}`);
}

function receiptKey(scope: AgentScope, requestId: string) {
  return `canvas-${createHash("sha256").update(`${scope.projectId}:${scope.threadId}:${requestId}`).digest("hex")}`;
}

function verifyOwner(receipt: z.infer<typeof receiptSchema>, scope: AgentScope, designId: string) {
  if (
    receipt.owner.project_id !== scope.projectId ||
    receipt.owner.thread_id !== scope.threadId ||
    receipt.owner.design_id !== designId
  )
    throw new AgentOperationError("FORBIDDEN", "This edit belongs to another thread or design.");
}

function applyOperation(
  document: DesignDocument,
  operation: Exclude<z.infer<typeof operationSchema>, { kind: "update" }>,
) {
  if ("node_ids" in operation) requireNodes(document, operation.node_ids);
  if ("node_id" in operation) requireNodes(document, [operation.node_id]);
  switch (operation.kind) {
    case "undo":
      throw new AgentOperationError(
        "CONFLICT",
        "Undo must be resolved against the private operation receipt.",
      );
    case "add": {
      const ids = new Set(document.nodes.map((node) => node.id));
      const authored = new Map(operation.nodes.map((node) => [node.id, node]));
      const existing = new Map(document.nodes.map((node) => [node.id, node]));
      const page = (id: string, depth = 0): string => {
        if (depth > 40) throw new Error("Layer hierarchy exceeds depth 40.");
        const prior = existing.get(id);
        if (prior) return nodePageId(prior);
        const node = authored.get(id);
        if (!node) throw new Error("Choose an existing parent or create it in this batch.");
        return (
          node.pageId ?? (node.parentId ? page(node.parentId, depth + 1) : document.pages[0].id)
        );
      };
      const nodes = [];
      for (const node of operation.nodes) {
        if (ids.has(node.id)) throw new Error("Layer ID already exists.");
        ids.add(node.id);
        if (node.parentId && isLayerLocked(document.nodes, node.parentId))
          throw new Error("Unlock the parent before adding layers.");
        const box = { x: 0, y: 0, width: 100, height: 100, ...node.box };
        nodes.push(
          designNodeSchema.parse({
            ...buildDrawnNode(node.id, node.type, node.parentId, box),
            ...node,
            pageId: page(node.id),
            box,
          }),
        );
      }
      return parseDesignDocument({
        ...document,
        nodes: [...document.nodes, ...nodes],
      });
    }
    case "delete":
      return removeLayers(document, operation.node_ids);
    case "duplicate": {
      for (const id of operation.node_ids)
        if (isLayerLocked(document.nodes, id))
          throw new Error("Unlock layers before duplicating them.");
      return duplicateLayers(document, operation.node_ids, randomUUID).document;
    }
    case "group":
      return wrapLayers(document, operation.node_ids, randomUUID(), operation.layout).document;
    case "ungroup":
      return unwrapLayer(document, operation.node_id);
    case "reparent":
      return reparentLayer(document, operation.node_id, operation.parent_id);
    case "reorder":
      return moveLayer(document, operation.node_id, operation.direction);
    case "align":
      return alignLayers(document, operation.node_ids, operation.axis);
    case "distribute":
      return distributeLayers(document, operation.node_ids, operation.axis);
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

export function prepareCanvasEdit(document: DesignDocument, operations: CanvasOperations) {
  if (document.nodes.length > 10000)
    throw new AgentOperationError(
      "BUSY",
      "Agent edits currently support designs with at most 10,000 layers.",
    );
  const before = document;
  const affected = operations.reduce(
    (count, operation) =>
      count +
      ("node_ids" in operation
        ? operation.node_ids.length
        : operation.kind === "add"
          ? operation.nodes.length
          : 1),
    0,
  );
  if (affected > 2000)
    throw new AgentOperationError("BUSY", "A transaction may target at most 2,000 layers.");
  for (let index = 0; index < operations.length;) {
    const operation = operations[index];
    if (operation.kind !== "update") {
      document = applyOperation(document, operation);
      index++;
      continue;
    }
    const edits: Parameters<typeof changedLayerBatch>[1] = [];
    let locks = document;
    while (index < operations.length && operations[index].kind === "update") {
      const update = operations[index];
      if (update.kind !== "update") break;
      requireNodes(locks, update.node_ids);
      for (const id of update.node_ids) {
        if (
          isLayerLocked(locks.nodes, id) &&
          !(update.changes.locked === false && Object.keys(update.changes).length === 1)
        )
          throw new AgentOperationError("CONFLICT", "Unlock locked layers before editing them.");
        edits.push({
          nodeId: id,
          changes: designNodeChangesSchema.parse(update.changes),
        });
      }
      if (update.changes.locked !== undefined) {
        const selected = new Set(update.node_ids);
        const locked = update.changes.locked;
        locks = {
          ...locks,
          nodes: locks.nodes.map((node) => (selected.has(node.id) ? { ...node, locked } : node)),
        };
      }
      index++;
    }
    document = parseDesignDocument({
      ...document,
      nodes: changedLayerBatch(document, edits),
    });
  }
  if (document.nodes.length > 10000)
    throw new AgentOperationError("BUSY", "A transaction cannot exceed 10,000 layers.");
  return trackDocumentChanges(before, document);
}

export class CanvasService {
  private writes = new Map<string, Promise<unknown>>();
  private closing = false;
  private pendingWrites = 0;
  constructor(
    private readonly options: {
      store: ProjectStore;
      receipts: CanvasReceipts;
      authorize(scope: AgentScope): Promise<void>;
      onChange(projectId: string): Promise<void>;
      renderSnapshot?(snapshot: CanvasSnapshot): Promise<CanvasRenderResult>;
      prepareEdit?(document: DesignDocument, operations: CanvasOperations): Promise<DesignDocument>;
      diff?(before: DesignDocument, after: DesignDocument): Promise<DocumentPatch>;
    },
  ) {}

  private async access(scope: AgentScope, designId: string, write = false) {
    if (this.closing) throw new Error("Canvas tools are closing.");
    scope.signal.throwIfAborted();
    if (!scope.designIds.includes(designId))
      throw new AgentOperationError("FORBIDDEN", "This design is not attached to this thread.");
    if (write && !scope.writable)
      throw new AgentOperationError("FORBIDDEN", "This thread has read-only canvas access.");
    await this.options.authorize(scope);
    scope.signal.throwIfAborted();
  }

  async read(scope: AgentScope, input: unknown) {
    const request = canvasReadSchema.parse(input);
    await this.access(scope, request.design_id);
    const file = await this.options.store.readDesign(scope.projectId, request.design_id, false);
    if (request.expected_version && file.version !== request.expected_version)
      throw new AgentOperationError(
        "CONFLICT",
        "This design changed. Read again from offset zero using its latest version.",
      );
    const document = file.document;
    if (request.page_id && !document.pages.some((page) => page.id === request.page_id))
      throw new AgentOperationError("NOT_FOUND", "Page not found.");
    if (request.node_ids) requireNodes(document, request.node_ids);
    const selected = request.node_ids ? new Set(request.node_ids) : undefined;
    if (selected && request.descendants) {
      const children = new Map<string, string[]>();
      for (const node of document.nodes)
        if (node.parentId) {
          const entries = children.get(node.parentId) ?? [];
          entries.push(node.id);
          children.set(node.parentId, entries);
        }
      const pending = [...selected];
      for (let index = 0; index < pending.length; index++)
        for (const id of children.get(pending[index]) ?? [])
          if (!selected.has(id)) {
            selected.add(id);
            pending.push(id);
          }
    }
    const query = request.query.trim().toLocaleLowerCase();
    const matching = document.nodes.filter(
      (node) =>
        (!selected || selected.has(node.id)) &&
        (!request.page_id || nodePageId(node) === request.page_id) &&
        (!query ||
          node.name.toLocaleLowerCase().includes(query) ||
          node.text?.toLocaleLowerCase().includes(query)),
    );
    const nodes = matching.slice(request.offset, request.offset + request.limit).map((node) =>
      request.detail === "full"
        ? node
        : {
            id: node.id,
            parentId: node.parentId,
            pageId: nodePageId(node),
            type: node.type,
            name: node.name,
            box: node.box,
            layout: node.layout,
            visible: node.visible,
            locked: node.locked,
            instanceOf: node.instanceOf,
            isComponent: node.isComponent,
            text: node.text?.slice(0, 300),
          },
    );
    const pages = boundedPage({
      items: document.pages,
      offset: request.page_offset,
      limit: request.page_limit,
      budget: 32 * 1024,
      oversized:
        "This page exceeds the read budget. Inspect its nodes with page_id and summary detail.",
    });
    const base = {
      design_id: file.id,
      name: file.name,
      version: file.version,
      pages,
      total_pages: document.pages.length,
      next_page_offset:
        request.page_offset + pages.length < document.pages.length
          ? request.page_offset + pages.length
          : null,
      nodes,
      total_nodes: matching.length,
      next_offset:
        request.offset + nodes.length < matching.length ? request.offset + nodes.length : null,
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(base));
    if (baseBytes > MAX_READ_BYTES)
      throw new AgentOperationError(
        "BUSY",
        "This read exceeds 128 KB. Reduce limit or page_limit, or request detail: 'summary'.",
      );
    const entries = request.include_tokens
      ? boundedPage({
          items: tokenEntries(document),
          offset: request.token_offset,
          limit: request.token_limit,
          budget: Math.min(64 * 1024, MAX_READ_BYTES - baseBytes - 1024),
          oversized: `The token/style entry at token_offset ${request.token_offset} exceeds the read budget. Use limit: 1 and page_limit: 1. To read other entries, continue at token_offset ${request.token_offset + 1} with expected_version. For a node summary, set include_tokens: false and detail: 'summary'.`,
        })
      : [];
    const totalEntries = request.include_tokens
      ? Object.keys(document.tokens).length +
        Object.keys(document.designTokens ?? {}).length +
        Object.keys(document.reusableStyles ?? {}).length
      : 0;
    const result = {
      ...base,
      ...(request.include_tokens
        ? {
            tokens: Object.fromEntries(
              entries
                .filter((entry) => entry.kind === "tokens")
                .map(({ key, value }) => [key, value]),
            ),
            designTokens: document.designTokens
              ? Object.fromEntries(
                  entries
                    .filter((entry) => entry.kind === "designTokens")
                    .map(({ key, value }) => [key, value]),
                )
              : undefined,
            reusableStyles: document.reusableStyles
              ? Object.fromEntries(
                  entries
                    .filter((entry) => entry.kind === "reusableStyles")
                    .map(({ key, value }) => [key, value]),
                )
              : undefined,
            total_token_entries: totalEntries,
            next_token_offset:
              request.token_offset + entries.length < totalEntries
                ? request.token_offset + entries.length
                : null,
          }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_READ_BYTES)
      throw new AgentOperationError(
        "BUSY",
        "This read exceeds 128 KB. Reduce limit, token_limit or page_limit, or request detail: 'summary'.",
      );
    await this.access(scope, request.design_id);
    return result;
  }

  edit(scope: AgentScope, input: unknown) {
    const request = canvasEditSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_RESULT_BYTES)
      return Promise.reject(
        new AgentOperationError("BUSY", "This edit exceeds the transaction size limit."),
      );
    if (this.pendingWrites >= 32)
      return Promise.reject(
        new AgentOperationError(
          "BUSY",
          "The canvas edit queue is full. Wait for an edit to finish.",
        ),
      );
    this.pendingWrites++;
    const key = `${scope.projectId}:${scope.threadId}`;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.editNow(scope, request));
    this.writes.set(key, operation);
    void operation
      .finally(() => {
        this.pendingWrites--;
        if (this.writes.get(key) === operation) this.writes.delete(key);
      })
      .catch(() => {});
    return operation;
  }

  private async editNow(scope: AgentScope, request: z.infer<typeof canvasEditSchema>) {
    await this.access(scope, request.design_id, true);
    const key = receiptKey(scope, request.request_id);
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const stored = await this.options.receipts.read(key);
    if (stored !== undefined) {
      const receipt = receiptSchema.parse(stored);
      verifyOwner(receipt, scope, request.design_id);
      if (receipt.fingerprint !== fingerprint)
        throw new AgentOperationError("CONFLICT", "This request ID belongs to a different edit.");
      if (receipt.kind === "pending")
        throw new AgentOperationError(
          "CONFLICT",
          "This edit may have completed before interruption. Inspect the design before issuing a new request.",
        );
      await this.access(scope, request.design_id, true);
      return receipt.result;
    }
    const file = await this.options.store.readDesign(scope.projectId, request.design_id, false);
    if (file.version !== request.expected_version)
      throw new AgentOperationError(
        "CONFLICT",
        "This design changed. Read its latest version before editing.",
      );
    let document = file.document;
    try {
      const undo = request.operations[0];
      if (undo.kind === "undo") {
        const original = await this.options.receipts.read(receiptKey(scope, undo.request_id));
        if (original === undefined)
          throw new AgentOperationError("NOT_FOUND", "No undoable edit was found in this thread.");
        const receipt = receiptSchema.parse(original);
        verifyOwner(receipt, scope, request.design_id);
        if (receipt.kind !== "complete")
          throw new AgentOperationError(
            "CONFLICT",
            "An interrupted edit cannot be undone automatically. Inspect the design first.",
          );
        if (receipt.result.version !== file.version)
          throw new AgentOperationError(
            "CONFLICT",
            "This design changed after that edit. Undo would overwrite intervening changes.",
          );
        document = applyDocumentPatch(document, receipt.inverse, true);
      } else {
        document = this.options.prepareEdit
          ? await this.options.prepareEdit(document, request.operations)
          : prepareCanvasEdit(document, request.operations);
      }
    } catch (error) {
      if (
        error instanceof AgentOperationError ||
        error instanceof CloudComputeBusyError ||
        error instanceof z.ZodError
      )
        throw error;
      throw new AgentOperationError(
        "CONFLICT",
        error instanceof Error ? error.message : "The canvas transaction could not be applied.",
      );
    }
    const before = new Set(file.document.nodes.map((node) => node.id));
    const created = document.nodes.filter((node) => !before.has(node.id)).map((node) => node.id);
    if (created.length > 1000 || Buffer.byteLength(JSON.stringify(created)) > 32 * 1024)
      throw new AgentOperationError(
        "BUSY",
        "A transaction may create at most 1,000 layers with a 32 KB identifier budget.",
      );
    const patch = this.options.diff
      ? await this.options.diff(file.document, document)
      : diffDocument(file.document, document);
    const inverse = invertPatch(patch);
    const owner = {
      project_id: scope.projectId,
      thread_id: scope.threadId,
      design_id: request.design_id,
    };
    const completed = {
      kind: "complete" as const,
      fingerprint,
      owner,
      patch,
      inverse,
      result: {
        design_id: request.design_id,
        version: "x".repeat(256),
        request_id: request.request_id,
        created_node_ids: created,
        undo_available: true as const,
      },
    };
    if (Buffer.byteLength(JSON.stringify(completed)) > 64 * 1024)
      throw new AgentOperationError(
        "BUSY",
        "This transaction exceeds the 64 KB undo history budget. Use a smaller batch.",
      );
    await this.access(scope, request.design_id, true);
    await this.options.receipts.write(key, {
      kind: "pending",
      fingerprint,
      owner,
      patch,
      inverse,
    });
    await this.access(scope, request.design_id, true);
    const result = await this.options.store.updateDesign(
      {
        projectId: scope.projectId,
        designId: request.design_id,
        expectedVersion: request.expected_version,
        document,
        beforeWrite: () => this.access(scope, request.design_id, true),
        signal: scope.signal,
      },
      { includeAssets: false },
    );
    const response = editResultSchema.parse({
      design_id: result.id,
      version: result.version,
      request_id: request.request_id,
      created_node_ids: created,
      undo_available: true,
    });
    await this.options.receipts.write(key, { ...completed, result: response });
    await this.options.onChange(scope.projectId);
    await this.access(scope, request.design_id, true);
    return response;
  }

  async render(scope: AgentScope, input: unknown) {
    const request = canvasRenderSchema.parse(input);
    await this.access(scope, request.design_id);
    const file = await this.options.store.readDesign(scope.projectId, request.design_id, false);
    if (file.version !== request.expected_version)
      throw new AgentOperationError("CONFLICT", "This design changed. Render its latest version.");
    if (file.document.nodes.length > 10000)
      throw new AgentOperationError(
        "BUSY",
        "Agent previews currently support designs with at most 10,000 layers.",
      );
    requireNodes(file.document, [request.node_id]);
    if (!this.options.renderSnapshot)
      return {
        kind: "unavailable" as const,
        design_id: file.id,
        version: file.version,
        reason: "A revision-isolated renderer is not available on this host.",
      };
    const selected = new Set([request.node_id]);
    const descendants = new Map<string, string[]>();
    for (const node of file.document.nodes)
      if (node.parentId) {
        const ids = descendants.get(node.parentId) ?? [];
        ids.push(node.id);
        descendants.set(node.parentId, ids);
      }
    const pending = [request.node_id];
    for (let index = 0; index < pending.length; index++)
      for (const id of descendants.get(pending[index]) ?? [])
        if (!selected.has(id)) {
          selected.add(id);
          pending.push(id);
        }
    if (selected.size > 5000)
      throw new AgentOperationError("BUSY", "Render a frame with at most 5,000 layers.");
    const document = {
      ...file.document,
      nodes: file.document.nodes.map((node) => ({ ...node })),
    };
    const root = document.nodes.find((node) => node.id === request.node_id);
    if (!root) throw new AgentOperationError("NOT_FOUND", "Render root not found.");
    if (
      root.box.width > 4096 ||
      root.box.height > 4096 ||
      root.box.width * root.box.height > 16_000_000
    )
      throw new AgentOperationError(
        "BUSY",
        "Render a frame no larger than 4,096 pixels per side and 16 megapixels.",
      );
    root.parentId = null;
    const assets: Record<string, string> = {};
    const warnings: string[] = [];
    let assetBytes = 0;
    const renderedNodes = resolvedDocumentNodes(document).filter((node) => selected.has(node.id));
    for (const id of documentAssetIds({ ...document, nodes: renderedNodes })) {
      await this.access(scope, request.design_id);
      const data = await this.options.store.readSyncAsset(scope.projectId, id);
      if (!data || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) {
        warnings.push(`Asset ${id} is unavailable or is not a supported raster image.`);
        continue;
      }
      assetBytes += Buffer.byteLength(data);
      if (assetBytes > 8 * 1024 * 1024)
        throw new AgentOperationError("BUSY", "Render assets exceed 8 MB.");
      assets[id] = data;
    }
    await this.access(scope, request.design_id);
    const result = await this.options.renderSnapshot({
      document,
      rootId: request.node_id,
      assets,
      width: root.box.width,
      warnings,
      projectId: scope.projectId,
      designId: file.id,
      version: file.version,
      signal: scope.signal,
    });
    if (Buffer.byteLength(result.data, "base64") > 2 * 1024 * 1024)
      throw new AgentOperationError("BUSY", "The rendered image exceeds 2 MB.");
    await this.access(scope, request.design_id);
    return { ...result, design_id: file.id, version: file.version };
  }

  async close() {
    this.closing = true;
    await Promise.allSettled(this.writes.values());
  }
}
