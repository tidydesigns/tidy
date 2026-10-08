import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SealedSecret = { version: 1; ciphertext: string; iv: string; tag: string };
export function sealSecret(
  value: unknown,
  key: Buffer,
  owner: string,
  purpose: string,
): SealedSecret {
  if (key.length !== 32) throw new Error("Agent encryption key must be 32 bytes.");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(["tidy:agents:v1", owner, purpose])));
  return {
    version: 1,
    iv: iv.toString("base64"),
    ciphertext: Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]).toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
export function openSecret(
  value: SealedSecret,
  key: Buffer,
  owner: string,
  purpose: string,
): unknown {
  if (value.version !== 1 || key.length !== 32) throw new Error("Unsupported agent secret.");
  const iv = Buffer.from(value.iv, "base64"),
    tag = Buffer.from(value.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid agent secret.");
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(["tidy:agents:v1", owner, purpose])));
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(value.ciphertext, "base64")),
      cipher.final(),
    ]).toString("utf8"),
  );
}
