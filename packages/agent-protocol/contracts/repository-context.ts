import { z } from "zod";

const machineSchema = z.string().min(1).max(255);

const gitRepositoryContextSchema = z.object({
  machine: machineSchema,
  repository: z.literal(true),
  branch: z.string().min(1).max(1024).nullable(),
  branches: z.array(z.string().min(1).max(1024)).max(10_000),
});

export const repositoryContextSchema = z.discriminatedUnion("repository", [
  z.object({
    machine: machineSchema,
    repository: z.literal(false),
    branch: z.null(),
    branches: z.tuple([]),
  }),
  gitRepositoryContextSchema,
]);

export type RepositoryContext = z.infer<typeof repositoryContextSchema>;

export const branchNameSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => !value.startsWith("-") && !/[\x00-\x20\x7f]/.test(value),
    "Choose an existing local branch.",
  );

export const branchSwitchReasonSchema = z.enum([
  "active-work",
  "switch-in-progress",
  "root-unavailable",
  "active-root-unavailable",
  "closing",
  "missing-branch",
  "local-changes",
  "branch-in-use",
  "operation-in-progress",
  "index-locked",
  "git-unavailable",
  "timeout",
  "failed",
]);
export type BranchSwitchReason = z.infer<typeof branchSwitchReasonSchema>;

export const branchSwitchMessages = {
  "active-work": "Wait for this checkout's active work to finish before switching branches.",
  "switch-in-progress": "Wait for the active branch switch to finish.",
  "root-unavailable": "Could not verify the repository root. Reopen the project and try again.",
  "active-root-unavailable":
    "Could not verify an active project's repository root. Wait for its work to finish.",
  closing: "Tidy is closing. Reopen it before switching branches.",
  "missing-branch":
    "That local branch is no longer available. Open the branch menu and choose another.",
  "local-changes":
    "Local changes would be overwritten. Commit or stash changes, or move conflicting files, then try again.",
  "branch-in-use":
    "That branch is open in another worktree. Open that checkout, or switch it to another branch first.",
  "operation-in-progress":
    "Finish or abort the current merge, rebase, cherry-pick, or revert before switching branches.",
  "index-locked": "Git's index is locked. Wait for other Git operations to finish, then try again.",
  "git-unavailable":
    "Git could not be started. Check that Git is installed and the project folder is available.",
  timeout: "The branch switch timed out. Check the checkout's current branch before trying again.",
  failed: "Could not switch branches. Check the checkout in your terminal and try again.",
} satisfies Record<BranchSwitchReason, string>;

export const branchSwitchResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("switched"),
    context: gitRepositoryContextSchema.extend({ branch: branchNameSchema }),
  }),
  z.object({ kind: z.literal("blocked"), reason: branchSwitchReasonSchema }),
]);
export type BranchSwitchResult = z.infer<typeof branchSwitchResultSchema>;
