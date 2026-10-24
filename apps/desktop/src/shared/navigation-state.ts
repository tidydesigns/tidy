import { z } from "zod";
import type { CloudAccount } from "./cloud-sync";

export const workspaceTargetSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("local") }),
    z.object({ kind: z.literal("cloud"), accountId: z.string(), organizationId: z.string() }),
  ])
  .nullable();
export const selectionSchema = z.record(z.string(), z.string().nullable());
export const fileBrowserSchema = z.object({
  folder: z.string().nullable(),
  fileId: z.string().nullable(),
  query: z.string(),
  view: z.enum(["grid", "list"]),
});
export const emptyFileBrowser: z.infer<typeof fileBrowserSchema> = {
  folder: null,
  fileId: null,
  query: "",
  view: "grid",
};

export function readNavigation<T>(
  storage: Pick<Storage, "getItem">,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  try {
    const parsed = schema.safeParse(
      JSON.parse(storage.getItem(`tidy:navigation:${key}`) ?? "null"),
    );
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export function restoreWorkspaceTarget({
  target,
  account,
  changedAccount,
  navigated,
}: {
  target: z.infer<typeof workspaceTargetSchema>;
  account: CloudAccount;
  changedAccount: boolean;
  navigated: boolean;
}): z.infer<typeof workspaceTargetSchema> {
  if (target?.kind === "local" && !changedAccount) return target;
  if (target?.kind === "cloud" && target.accountId === account.id) {
    return account.organizations.some((o) => o.id === target.organizationId && o.canEdit)
      ? target
      : { kind: "local" };
  }
  if (navigated && !changedAccount) return target;
  const organization = account.organizations.find((o) => o.canEdit);
  return organization
    ? { kind: "cloud", accountId: account.id, organizationId: organization.id }
    : { kind: "local" };
}
