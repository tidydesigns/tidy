import { z } from "zod";
import { DESIGN_DOCUMENT_LIMITS } from "./document-limits";
import type { designDocumentSchema, DesignDocument, DesignNode, DocumentParser } from "./document";

/** Own cache state separately from schemas; each parser instance validates all new graph states. */
export function createImmutableDocumentParser(
  schema: typeof designDocumentSchema,
  validateGraph: (document: DesignDocument) => void,
): DocumentParser {
  // Only nodes parsed and recursively frozen here can bypass schema parsing.
  // A caller-frozen object is still untrusted, and mutable/server parses retain
  // their independently owned output. Weak membership does not retain snapshots.
  const immutableNodes = new WeakSet<object>();
  const immutableDocuments = new WeakSet<object>();
  const immutableBoxes = new WeakSet<object>();
  const immutableStyles = new WeakSet<object>();
  // Bounded weak candidates bridge preparation and optimistic patch application.
  // Source objects are never cached, and value equality is required before reuse.
  const recentImmutableNodes = new Map<string, WeakRef<DesignNode>>();
  // Reuse one iterator: recreating it for each eviction repeatedly walks the
  // Map's deleted prefix when opening another large file with different IDs.
  let oldestNode = recentImmutableNodes.keys();
  let recentImmutableDocument: WeakRef<DesignDocument> | undefined;
  const frozenValues = new WeakSet<object>();
  function freezeValue<T>(value: T): T {
    if (value && typeof value === "object" && !frozenValues.has(value)) {
      for (const child of Object.values(value)) freezeValue(child);
      Object.freeze(value);
      frozenValues.add(value);
    }
    return value;
  }
  const nodeSchema = schema.shape.nodes.element;
  const immutableNodeSchema = nodeSchema.extend({
    box: z
      .unknown()
      .transform((input) =>
        input && typeof input === "object" && immutableBoxes.has(input)
          ? (input as DesignNode["box"])
          : nodeSchema.shape.box.parse(input),
      ),
    style: z
      .unknown()
      .transform((input) =>
        input && typeof input === "object" && immutableStyles.has(input)
          ? (input as DesignNode["style"])
          : nodeSchema.shape.style.parse(input),
      ),
  });
  function rememberImmutableNode(node: DesignNode) {
    freezeValue(node);
    immutableNodes.add(node);
    immutableBoxes.add(node.box);
    immutableStyles.add(node.style);
    if (recentImmutableNodes.get(node.id)?.deref() !== node) {
      recentImmutableNodes.delete(node.id);
      recentImmutableNodes.set(node.id, new WeakRef(node));
      if (recentImmutableNodes.size > DESIGN_DOCUMENT_LIMITS.nodes) {
        let oldest = oldestNode.next();
        if (oldest.done) {
          oldestNode = recentImmutableNodes.keys();
          oldest = oldestNode.next();
        }
        if (!oldest.done) recentImmutableNodes.delete(oldest.value);
      }
    }
    return node;
  }
  const immutableDocumentSchema = schema.extend({
    nodes: z
      .array(
        z.unknown().transform((input) => {
          if (input && typeof input === "object") {
            if (immutableNodes.has(input)) return input as DesignNode;
            if ("id" in input && typeof input.id === "string") {
              const previous = recentImmutableNodes.get(input.id)?.deref();
              if (previous && sameParsedValue(previous, input)) return previous;
            }
          }
          return immutableNodeSchema.parse(input);
        }),
      )
      .max(DESIGN_DOCUMENT_LIMITS.nodes),
  });

  function sameParsedValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (
      !a ||
      !b ||
      typeof a !== "object" ||
      typeof b !== "object" ||
      Array.isArray(a) !== Array.isArray(b)
    )
      return false;
    const left = a as Record<string, unknown>,
      right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && sameParsedValue(left[key], right[key]))
    );
  }

  /** Fully validate each new editor document state. Reuse only owned frozen
   * nodes or a complete state equal to a previously validated frozen document. */
  function parse(input: unknown): DesignDocument {
    if (input && typeof input === "object" && immutableDocuments.has(input))
      return input as DesignDocument;
    // A newly opened file has no reusable nodes. Parse its array in one schema
    // pass rather than starting a separate parser/transform for every layer.
    // Owned snapshots and equivalent transports still take the identity path.
    const sourceNodes =
      input && typeof input === "object" && "nodes" in input ? input.nodes : undefined;
    const reusable =
      Array.isArray(sourceNodes) &&
      sourceNodes.length <= DESIGN_DOCUMENT_LIMITS.nodes &&
      sourceNodes.some(
        (node: unknown) =>
          node &&
          typeof node === "object" &&
          (immutableNodes.has(node) ||
            ("id" in node &&
              typeof node.id === "string" &&
              recentImmutableNodes.get(node.id)?.deref())),
      );
    const document = reusable ? immutableDocumentSchema.parse(input) : schema.parse(input);
    const previous = recentImmutableDocument?.deref();
    // Parsing still validates all metadata. Reuse equal, parser-owned immutable
    // values afterward so token/image contexts and page indexes stay stable,
    // including snapshots cloned across worker/IPC/network boundaries.
    if (input && typeof input === "object") {
      const source = input as Record<string, unknown>;
      const target = document as unknown as Record<string, unknown>;
      for (const key of Object.keys(target)) {
        if (key === "nodes") continue;
        const prior = source[key];
        if (
          prior &&
          typeof prior === "object" &&
          frozenValues.has(prior) &&
          sameParsedValue(target[key], prior)
        )
          target[key] = prior;
        else if (previous) {
          const saved = (previous as unknown as Record<string, unknown>)[key];
          if (saved && typeof saved === "object" && sameParsedValue(target[key], saved))
            target[key] = saved;
        }
      }
    }
    if (previous && sameParsedValue(document, previous)) return previous;
    validateGraph(document);
    for (const node of document.nodes) rememberImmutableNode(node);
    freezeValue(document);
    immutableDocuments.add(document);
    recentImmutableDocument = new WeakRef(document);
    return document;
  }

  return parse;
}
