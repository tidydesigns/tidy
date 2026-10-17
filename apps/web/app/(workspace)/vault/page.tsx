import { filesPage } from "@/components/workspace/page-layout";
import { getWorkspace } from "@/lib/workspace/server";
import { redirect } from "next/navigation";
import { listVaultLogins } from "@/lib/vault/logins";
import { VaultContent } from "@/app/vault/vault-content";
import { vaultEnabled } from "@/lib/vault/feature-flag";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Vault · Tidy" };

export default async function VaultPage() {
  const { session } = await getWorkspace();
  if (!(await vaultEnabled(session.user.id))) redirect("/files");

  const logins = await listVaultLogins(session.user.id);

  return (
    <main className={filesPage} data-page-content="vault">
      <VaultContent logins={logins} />
    </main>
  );
}
