import { createHash } from "node:crypto";

export const imageDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Never publish a pointer or prune the database copy until the uploaded bytes match. */
export async function verifiedObject(
  key: string,
  expected: { sha256: string; byteSize: number },
  read: (key: string) => Promise<ArrayBuffer>,
) {
  const bytes = new Uint8Array(await read(key));
  if (bytes.byteLength !== expected.byteSize || imageDigest(bytes) !== expected.sha256)
    throw new Error("R2 object failed byte/hash verification.");
  return bytes;
}
