import { z } from "zod";
export const MAX_TOOL_ACTIVITIES = 250;
export const MAX_TOOL_INPUT = 8_000;
export const MAX_TOOL_OUTPUT = 32_000;
export const MAX_TOOL_LOG_CHARACTERS = 1_000_000;
export const toolActivitySchema = z.object({
  id: z.string().uuid(),
  afterMessageId: z.string().uuid(),
  kind: z.enum(["command", "test", "edit", "search", "read", "tool"]),
  title: z.string().max(240),
  toolName: z.string().max(120),
  status: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  input: z.string().max(MAX_TOOL_INPUT).optional(),
  output: z.string().max(MAX_TOOL_OUTPUT).optional(),
  inputTruncated: z.boolean().optional(),
  outputTruncated: z.boolean().optional(),
  exitCode: z.number().int().optional(),
  files: z
    .array(
      z.object({
        path: z.string().max(1000),
        kind: z.enum(["added", "modified", "deleted", "written"]),
      }),
    )
    .max(50)
    .optional(),
  parentToolId: z.string().max(200).optional(),
});
export type ToolActivity = z.infer<typeof toolActivitySchema>;
export type ToolActivityUpdate = Omit<
  ToolActivity,
  "id" | "afterMessageId" | "startedAt" | "endedAt"
> & { id: string };
export function toolLogSize(activity: ToolActivity) {
  return (
    activity.title.length +
    activity.toolName.length +
    (activity.input?.length ?? 0) +
    (activity.output?.length ?? 0) +
    (activity.files?.reduce((total, file) => total + file.path.length, 0) ?? 0)
  );
}
export const toolStatusLabel: Record<ToolActivity["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};
