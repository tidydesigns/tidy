import { z } from "zod";

export const threadModeSchema = z.enum(["worktree", "local"]);
export type ThreadMode = z.infer<typeof threadModeSchema>;

export const threadWorktreeSchema = z.object({
  path: z.string().min(1).max(4096),
  root: z.string().min(1).max(4096),
  branch: z.string().min(1).max(200),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export type ThreadWorktree = z.infer<typeof threadWorktreeSchema>;
