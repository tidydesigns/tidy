import { z } from "zod";

export function repositoryKey(value: string): string | null {
  if (/[\s\x00-\x1f\x7f]/.test(value)) return null;
  const scp = value.includes("://") ? null : /^(?:[\w.-]+@)?([\w.-]+):([\w./-]+)$/.exec(value);
  try {
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : value);
    if (!["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash)
      return null;
    if (url.protocol === "https:" && url.username) return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    if (!url.hostname || !path || path.split("/").some((part) => part === ".." || part === "."))
      return null;
    const host = url.hostname.toLowerCase();
    const port = url.port && !(url.protocol === "ssh:" && url.port === "22") ? `:${url.port}` : "";
    return `${host}${port}/${host === "github.com" ? path.toLowerCase() : path}`;
  } catch {
    return null;
  }
}

export const repositoryURLSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) => repositoryKey(value) !== null,
    "Enter an HTTPS or SSH repository URL without embedded credentials.",
  );
export const projectSetupIssueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository-mismatch"), repository: repositoryURLSchema.nullable() }),
  z.object({
    kind: z.literal("failed"),
    reason: z.enum([
      "folder-unavailable",
      "destination-unavailable",
      "clone-failed",
      "invalid-repository",
      "project-folder-missing",
    ]),
  }),
]);
export type ProjectSetupIssue = z.infer<typeof projectSetupIssueSchema>;

const repositoryPathSchema = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === "."),
    "Choose a folder inside the repository.",
  );
export const projectCheckoutSchema = z.object({
  projectId: z.string().uuid(),
  remotes: z.array(repositoryURLSchema).max(100),
  repositoryPath: repositoryPathSchema.nullable().default(null),
});
export type ProjectCheckout = z.infer<typeof projectCheckoutSchema>;
export const projectSetupSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("folder"),
      path: z.string().min(1).max(4096).startsWith("/"),
      repository: repositoryURLSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("clone"),
      parent: z.string().min(1).max(4096).startsWith("/"),
      repository: repositoryURLSchema,
      repositoryPath: repositoryPathSchema.optional(),
    })
    .strict(),
]);
export type ProjectSetup = z.infer<typeof projectSetupSchema>;

export function matchingCheckouts({
  source,
  candidates,
}: {
  source: ProjectCheckout;
  candidates: ProjectCheckout[];
}) {
  const key = source.remotes[0] ? repositoryKey(source.remotes[0]) : null;
  return candidates.filter(
    (candidate) =>
      key !== null &&
      source.repositoryPath !== null &&
      source.repositoryPath === candidate.repositoryPath &&
      candidate.remotes[0] !== undefined &&
      repositoryKey(candidate.remotes[0]) === key,
  );
}
