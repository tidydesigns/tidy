import { z } from "zod";

// Update discovery is independent of the harnesses supported for conversations.
export const updatableHarnessIdSchema = z.enum(["codex", "claude", "opencode"]);
export type UpdatableHarnessId = z.infer<typeof updatableHarnessIdSchema>;
export const harnessNames = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };
export const harnessUpdateSchema = z.object({
  id: updatableHarnessIdSchema,
  status: z.enum(["current", "available", "queued", "installing", "updated", "error"]),
  installedVersion: z.string(),
  latestVersion: z.string(),
  canInstall: z.boolean(),
  waitReason: z.enum(["turn", "installer"]).optional(),
  message: z.string().optional(),
});
export const harnessUpdatesSchema = z.array(harnessUpdateSchema).max(3);
export type HarnessUpdateState = z.infer<typeof harnessUpdateSchema>;
