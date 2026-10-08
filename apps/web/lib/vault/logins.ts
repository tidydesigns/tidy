import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { requireVerifiedUser } from "@/lib/security/user-authority";
import { PublicActionError } from "@/lib/security/public-error";
import { reservePersonalAttempts } from "@/lib/security/personal-budget";
import { decryptVaultLogin, encryptVaultLogin } from "./server";
import type { EncryptedVaultCredentials } from "./crypto";

export const VAULT_LOGIN_LIMIT = 1000;
type LoginPatch = { name?: string; username?: string; password?: string };
type StoredLogin = EncryptedVaultCredentials & { keyVersion: number; name: string };

function validate(patch: LoginPatch) {
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    !Object.values(patch).some((value) => value !== undefined) ||
    Object.keys(patch).some((key) => !["name", "username", "password"].includes(key))
  )
    throw new PublicActionError("Choose a valid login field.");
  if (
    patch.name !== undefined &&
    (typeof patch.name !== "string" ||
      !patch.name.trim() ||
      patch.name.trim().length > 100 ||
      /[\u0000-\u001f\u007f]/.test(patch.name))
  )
    throw new PublicActionError("Enter a name of 100 characters or fewer.");
  if (
    patch.username !== undefined &&
    (typeof patch.username !== "string" ||
      !patch.username.trim() ||
      patch.username.trim().length > 320)
  )
    throw new PublicActionError("Enter a username or email of 320 characters or fewer.");
  if (
    patch.password !== undefined &&
    (typeof patch.password !== "string" || !patch.password || patch.password.length > 4096)
  )
    throw new PublicActionError("Enter a password of 4096 characters or fewer.");
}
function loginId(id: string) {
  if (typeof id !== "string" || !id || id.length > 200)
    throw new PublicActionError("Login not found.");
}
async function withVaultUser<T>(
  userId: string,
  write: boolean,
  work: (client: PoolClient) => Promise<T>,
) {
  await requireVerifiedUser(db, userId);
  await reservePersonalAttempts(write ? "vault-write" : "vault-read", userId);
  const client = await db.connect();
  try {
    await client.query("begin");
    if (write)
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `vault:${userId}`,
      ]);
    await requireVerifiedUser(client, userId, true);
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function createVaultLogin(
  userId: string,
  name: string,
  username: string,
  password: string,
) {
  if ([name, username, password].some((value) => typeof value !== "string"))
    throw new PublicActionError("Choose valid login fields.");
  validate({ name, username, password });
  return withVaultUser(userId, true, async (client) => {
    const count = (
      await client.query<{ count: number }>(
        `select count(*)::int as count from "vaultLogin" where "userId"=$1`,
        [userId],
      )
    ).rows[0]!.count;
    if (count >= VAULT_LOGIN_LIMIT)
      throw new PublicActionError("Your Vault is full. Remove a login before adding another.");
    const id = randomUUID();
    const encrypted = encryptVaultLogin({ username: username.trim(), password }, userId, id);
    await client.query(
      'insert into "vaultLogin" ("id", "userId", "name", "ciphertext", "iv", "authTag", "keyVersion", "createdAt") values ($1, $2, $3, $4, $5, $6, 1, now())',
      [id, userId, name.trim(), encrypted.ciphertext, encrypted.iv, encrypted.authTag],
    );
    return { id, name: name.trim() };
  });
}

export async function updateVaultLogin(userId: string, id: string, patch: LoginPatch) {
  loginId(id);
  validate(patch);
  return withVaultUser(userId, true, async (client) => {
    const stored = (
      await client.query<StoredLogin>(
        'select "name", "ciphertext", "iv", "authTag", "keyVersion" from "vaultLogin" where "id" = $1 and "userId" = $2 for update',
        [id, userId],
      )
    ).rows[0];
    if (!stored) throw new PublicActionError("Login not found.");
    const name = patch.name?.trim() ?? stored.name;
    if (patch.username !== undefined || patch.password !== undefined) {
      const previous = decryptVaultLogin(stored, userId, id);
      const encrypted = encryptVaultLogin(
        {
          username: patch.username?.trim() ?? previous.username,
          password: patch.password ?? previous.password,
        },
        userId,
        id,
      );
      await client.query(
        'update "vaultLogin" set "name" = $1, "ciphertext" = $2, "iv" = $3, "authTag" = $4 where "id" = $5 and "userId" = $6',
        [name, encrypted.ciphertext, encrypted.iv, encrypted.authTag, id, userId],
      );
    } else
      await client.query('update "vaultLogin" set "name" = $1 where "id" = $2 and "userId" = $3', [
        name,
        id,
        userId,
      ]);
    return { id, name };
  });
}

export async function deleteVaultLogin(userId: string, id: string) {
  loginId(id);
  return withVaultUser(userId, true, async (client) => {
    if (
      !(
        await client.query('delete from "vaultLogin" where "id" = $1 and "userId" = $2', [
          id,
          userId,
        ])
      ).rowCount
    )
      throw new PublicActionError("Login not found.");
  });
}

/** Metadata only. Decryption is used solely for server-side credential updates. */
export async function listVaultLogins(userId: string) {
  return withVaultUser(userId, false, async (client) => {
    const rows = (
      await client.query<{ id: string; name: string }>(
        'select "id","name" from "vaultLogin" where "userId"=$1 order by "createdAt" desc,"id" limit $2',
        [userId, VAULT_LOGIN_LIMIT + 1],
      )
    ).rows;
    if (rows.length > VAULT_LOGIN_LIMIT)
      throw new PublicActionError(
        "Your Vault exceeds the supported size. Contact support to recover it.",
      );
    return rows;
  });
}
