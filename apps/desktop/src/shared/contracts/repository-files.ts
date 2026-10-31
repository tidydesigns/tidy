import { z } from "zod";

export const repositoryPathSchema = z
  .string()
  .max(4096)
  .refine(
    (path) =>
      !path.includes("\\") &&
      !/[\x00-\x1f\x7f]/.test(path) &&
      (path === "" ||
        path.split("/").every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            ![".git", "git~1"].includes(
              part
                .split(":")[0]
                .replace(/[. ]+$/, "")
                .toLowerCase(),
            ),
        )),
    "Choose a path inside this repository.",
  );
export const repositoryEntrySchema = z.object({
  path: repositoryPathSchema,
  name: z.string().max(255),
  kind: z.enum(["directory", "file", "symlink", "unsupported"]),
});
export const repositoryDirectorySchema = z.object({
  entries: z.array(repositoryEntrySchema).max(5000),
  limited: z.boolean(),
});
export const repositoryChangeSchema = z.object({
  path: repositoryPathSchema,
  previousPath: repositoryPathSchema.nullable(),
  filtered: z.literal(true).optional(),
  status: z.enum([
    "modified",
    "added",
    "deleted",
    "renamed",
    "untracked",
    "conflict",
    "typechange",
  ]),
});
export const repositoryChangesSchema = z.object({
  repository: z.boolean(),
  head: z.string().max(100).nullable(),
  changes: z.array(repositoryChangeSchema).max(20000),
});
export const repositoryFileSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string().max(2 * 1024 * 1024),
    view: z.enum(["diff", "file"]),
    comparison: z.enum(["head", "empty", "unborn", "none"]),
    deleted: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum([
      "binary",
      "oversized",
      "symlink",
      "unsupported",
      "missing",
      "conflict",
      "filtered",
    ]),
  }),
]);
export type RepositoryEntry = z.infer<typeof repositoryEntrySchema>;
export type RepositoryDirectory = z.infer<typeof repositoryDirectorySchema>;
export type RepositoryChange = z.infer<typeof repositoryChangeSchema>;
export type RepositoryChanges = z.infer<typeof repositoryChangesSchema>;
export type RepositoryFile = z.infer<typeof repositoryFileSchema>;
