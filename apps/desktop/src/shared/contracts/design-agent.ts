import { z } from "zod";
import type { CloudState } from "./cloud-sync";

export const designAgentActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("design-create"),
      requestId: z.uuid(),
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
  z.object({ kind: z.literal("design-open"), designId: z.uuid() }).strict(),
  z.object({ kind: z.literal("design-state"), designId: z.uuid() }).strict(),
]);
export type DesignAgentAction = z.infer<typeof designAgentActionSchema>;
export type DesignAgentSync = Pick<CloudState["bindings"][number], "fileId" | "status" | "message">;
export type DesignAgentResult = {
  design: { id: string; name: string; path: string };
  previewAttached: boolean;
  sync: DesignAgentSync | { status: "local" | "unconnected"; message?: string };
};
export type DesignAgentHandler = (
  action: DesignAgentAction,
  signal: AbortSignal,
) => Promise<DesignAgentResult>;
