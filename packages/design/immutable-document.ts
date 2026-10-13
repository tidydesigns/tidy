import { z } from "zod";
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
      if (recentImmutableNodes.size > 5000)
        recentImmutableNodes.delete(recentImmutableNodes.keys().next().value!);
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
          return rememberImmutableNode(immutableNodeSchema.parse(input));
        }),
      )
      .max(5000),
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
    const document = immutableDocumentSchema.parse(input);
    // Parsing still validates all metadata. Reuse equal, parser-owned immutable
    // values afterward so token/image contexts and page indexes stay stable.
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
      }
    }
    const previous = recentImmutableDocument?.deref();
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
