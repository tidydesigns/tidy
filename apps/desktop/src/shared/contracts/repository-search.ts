import { z } from "zod";
import { repositoryEntrySchema } from "./repository-files";

export const repositorySearchQuerySchema = z.string().trim().min(1).max(256);
export const repositorySearchSchema = z.object({
  entries: z.array(repositoryEntrySchema).max(500),
  limited: z.boolean(),
});
export type RepositorySearch = z.infer<typeof repositorySearchSchema>;
