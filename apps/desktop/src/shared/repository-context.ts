import { z } from "zod";

const machineSchema = z.string().min(1).max(255);

export const repositoryContextSchema = z.discriminatedUnion("repository", [
  z.object({
    machine: machineSchema,
    repository: z.literal(false),
    branch: z.null(),
    branches: z.tuple([]),
  }),
  z.object({
    machine: machineSchema,
    repository: z.literal(true),
    branch: z.string().min(1).max(1024).nullable(),
    branches: z.array(z.string().min(1).max(1024)).max(10_000),
  }),
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
