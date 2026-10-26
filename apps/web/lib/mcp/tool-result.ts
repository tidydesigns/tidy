import { actionError } from "@/lib/action-error";
import { VersionError } from "@/lib/design/file-versions";
export function toolResult(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
export async function toolOperation(work: () => Promise<object>, fallback: string) {
  try {
    return toolResult(await work());
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof VersionError ? error.message : actionError(error, fallback),
        },
      ],
      isError: true as const,
    };
  }
}
