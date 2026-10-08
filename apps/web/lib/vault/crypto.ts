import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type VaultCredentials = { username: string; password: string };
export type EncryptedVaultCredentials = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

function associatedData(userId: string, loginId: string) {
  return Buffer.from(`bella:vault:v1:${userId}:${loginId}`, "utf8");
}

export function encryptCredentials(
  credentials: VaultCredentials,
  key: Buffer,
  userId: string,
  loginId: string,
): EncryptedVaultCredentials {
  if (key.length !== 32) throw new Error("Invalid vault key length");

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(associatedData(userId, loginId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptCredentials(
  encrypted: EncryptedVaultCredentials,
  key: Buffer,
  userId: string,
  loginId: string,
): VaultCredentials {
  if (key.length !== 32) throw new Error("Invalid vault key length");

  const iv = Buffer.from(encrypted.iv, "base64");
  const authTag = Buffer.from(encrypted.authTag, "base64");
  if (iv.length !== 12 || authTag.length !== 16) throw new Error("Invalid vault ciphertext");

  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAAD(associatedData(userId, loginId));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  const credentials: unknown = JSON.parse(plaintext.toString("utf8"));
  if (
    typeof credentials !== "object" ||
    credentials === null ||
    !("username" in credentials) ||
    typeof credentials.username !== "string" ||
    !("password" in credentials) ||
    typeof credentials.password !== "string"
  )
    throw new Error("Invalid vault credentials");

  return { username: credentials.username, password: credentials.password };
}
