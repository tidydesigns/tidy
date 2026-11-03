import "server-only";
import {
  decryptCredentials,
  encryptCredentials,
  type EncryptedVaultCredentials,
  type VaultCredentials,
} from "./crypto";

const encryptionKeyPattern = /^[A-Za-z0-9+/]{43}=$/;

function vaultKey() {
  const encoded = process.env.VAULT_ENCRYPTION_KEY;
  if (!encoded || !encryptionKeyPattern.test(encoded)) {
    throw new Error("VAULT_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return Buffer.from(encoded, "base64");
}

export function encryptVaultLogin(credentials: VaultCredentials, userId: string, loginId: string) {
  return encryptCredentials(credentials, vaultKey(), userId, loginId);
}

// Used for server-side credential updates. No user-facing route returns decrypted credentials.
export function decryptVaultLogin(
  encrypted: EncryptedVaultCredentials & { keyVersion: number },
  userId: string,
  loginId: string,
) {
  if (encrypted.keyVersion !== 1) throw new Error("Unsupported vault key version");
  return decryptCredentials(encrypted, vaultKey(), userId, loginId);
}
