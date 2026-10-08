import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type Sealed = { iv: string; tag: string; body: string };
function key() {
  const value = process.env.VAULT_ENCRYPTION_KEY;
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new Error("Connector encryption is not configured.");
  return Buffer.from(value, "base64");
}
export function seal(value: string, context: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(`tidy:connector:v1:${context}`));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    body: body.toString("base64"),
  };
}
export function unseal(value: Sealed, context: string) {
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(value.iv, "base64"));
  decipher.setAAD(Buffer.from(`tidy:connector:v1:${context}`));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.body, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function randomToken() {
  return randomBytes(32).toString("base64url");
}
export function pkceChallenge(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}
export function validSignature(body: string, signature: string | null, secret: string) {
  return Boolean(
    signature &&
    /^[a-f0-9]{64}$/.test(signature) &&
    timingSafeEqual(
      createHmac("sha256", secret).update(body).digest(),
      Buffer.from(signature, "hex"),
    ),
  );
}
