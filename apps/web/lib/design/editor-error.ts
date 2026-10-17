import { ZodError } from "zod";

/** Keep validation payloads out of the canvas while preserving useful edit conflicts. */
export function editorErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error instanceof ZodError || error.name === "ZodError")
    return fallback;
  const message = error.message.trim();
  if (
    /^Detach the instance before (?:adding or reparenting|deleting or moving|reparenting|reordering) its children\.$/.test(
      message,
    )
  )
    return "This layer belongs to a component instance. Use Detach instance in the Component section before changing its layers.";
  // Server errors can carry a serialized Zod issue array rather than its class.
  if (message.startsWith("[")) {
    if (message.length > 100_000) return fallback;
    try {
      const issues: unknown = JSON.parse(message);
      if (
        Array.isArray(issues) &&
        issues.some(
          (issue) =>
            issue &&
            typeof issue === "object" &&
            "code" in issue &&
            "path" in issue &&
            "message" in issue,
        )
      )
        return fallback;
    } catch {
      // Ordinary application messages retain their existing wording.
    }
  }
  return message || fallback;
}
