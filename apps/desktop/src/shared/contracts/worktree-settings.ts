import { z } from "zod";

// A restricted Git ref prefix keeps generated names portable and out of path syntax.
export const worktreePreferencesSchema = z
  .object({
    naming: z.enum(["uuid", "prompt"]).default("uuid"),
    branchPrefix: z
      .string()
      .max(60)
      .regex(/^(?:[a-z][a-z0-9-]*\/)*[a-z][a-z0-9-]*[-/]$/)
      .default("feat/tidy-"),
    deleteWithThread: z.boolean().default(false),
    inactiveDays: z
      .union([z.literal(0), z.literal(7), z.literal(14), z.literal(30), z.literal(90)])
      .default(0),
    deleteMerged: z.boolean().default(false),
    deleteUnchanged: z.boolean().default(false),
  })
  .strict();
export type WorktreePreferences = z.infer<typeof worktreePreferencesSchema>;
export const defaultWorktreePreferences = worktreePreferencesSchema.parse({});

export const worktreeStorageEntrySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string(),
  title: z.string(),
  branch: z.string(),
  path: z.string(),
  bytes: z.number().nonnegative(),
  busy: z.boolean(),
  hasChanges: z.boolean(),
});
export const worktreeStorageSchema = z.object({
  preferences: worktreePreferencesSchema,
  entries: z.array(worktreeStorageEntrySchema),
});
export type WorktreeStorage = z.infer<typeof worktreeStorageSchema>;
