export const MAX_MERMAID_EDGES = 200;

export class MermaidRenderError extends Error {
  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : "";
    super(
      message.startsWith("Edge limit exceeded.")
        ? `This diagram exceeds the ${MAX_MERMAID_EDGES}-edge preview limit. Split it into smaller diagrams or copy the code to view it elsewhere.`
        : message === "This diagram has no content."
          ? "This diagram has no content. Add nodes or data to preview it."
          : "Couldn’t render this diagram. Check its Mermaid syntax or copy the code to view it elsewhere.",
      { cause },
    );
    this.name = "MermaidRenderError";
  }
}
