"use server";
import { PublicActionError } from "@/lib/security/public-error";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { createVaultLogin, deleteVaultLogin, updateVaultLogin } from "@/lib/vault/logins";
import { actionError } from "@/lib/action-error";
import { vaultEnabled } from "@/lib/vault/feature-flag";

async function userId() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new PublicActionError("Sign in to manage your logins.");
  if (!(await vaultEnabled(session.user.id)))
    throw new PublicActionError("Vault is not available.");
  return session.user.id;
}

export async function addVaultLogin(formData: FormData) {
  try {
    const login = await createVaultLogin(
      await userId(),
      String(formData.get("name") ?? ""),
      String(formData.get("username") ?? ""),
      String(formData.get("password") ?? ""),
    );
    return { ok: true, login };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not add this login.") };
  }
}

export async function editVaultLogin(
  id: string,
  field: "name" | "username" | "password",
  value: string,
) {
  try {
    if (!["name", "username", "password"].includes(field))
      return { error: "Choose a valid login field." };
    const login = await updateVaultLogin(await userId(), id, { [field]: value });
    return { login };
  } catch (error) {
    return { error: actionError(error, "Could not update this login.") };
  }
}

export async function removeVaultLogin(id: string) {
  try {
    await deleteVaultLogin(await userId(), id);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not delete this login.") };
  }
}
