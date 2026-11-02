import { z } from "zod";
import { branchNameSchema } from "./repository-context";

export const threadCompletionSchema = z
  .object({
    merged: z.boolean().default(true),
    target: z.enum(["default", "named", "any"]).default("default"),
    branches: z.array(branchNameSchema).max(20).default([]),
    pullRequests: z.enum(["all", "any"]).default("all"),
    closed: z.boolean().default(false),
    inactiveDays: z
      .union([z.literal(0), z.literal(7), z.literal(14), z.literal(30), z.literal(90)])
      .default(0),
  })
  .strict();
export type ThreadCompletion = z.infer<typeof threadCompletionSchema>;
export const defaultThreadCompletion = threadCompletionSchema.parse({});
export const threadDoneReasonSchema = z.enum(["merged", "closed", "inactive"]);
export type ThreadDoneReason = z.infer<typeof threadDoneReasonSchema>;

export type CompletionPullRequest = {
  state: "open" | "draft" | "merged" | "closed";
  baseBranch: string;
  defaultBranch: string | null;
  endedAt: string | null;
};
