import {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  validateImages,
  validateSignature,
} from "@/lib/feedback/validation";

export { IMAGE_TYPES, MAX_IMAGE_BYTES };
export type AvatarKind = "user" | "organization";

export async function avatarBytes(file: File) {
  validateImages([file]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateSignature(file.type, bytes);
  return bytes;
}

export function avatarPath(kind: AvatarKind, id: string) {
  return `/api/avatars/${kind}/${encodeURIComponent(id)}`;
}

// Only objects created by this feature can be removed; external images stay untouched.
export function avatarObjectKey(url: string | null, kind: AvatarKind, id: string) {
  if (!url) return null;
  const prefix = `${avatarPath(kind, id)}?v=`;
  if (!url.startsWith(prefix)) return null;
  const version = url.slice(prefix.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(version))
    return null;
  return `avatars/${kind}/${encodeURIComponent(id)}/${version}`;
}
