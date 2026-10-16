import { GitHubRequestError } from "./request-error";
import * as z from "zod";
import { removeComponentReferences } from "@/lib/design/component-variants";
import type { DesignDocument } from "@/lib/design/document";

/** Metadata occupies a fixed 8 KiB reservation per retained review. Bound all
 * provider fields before link, reconciliation or webhook publication. */
const providerString = (limit: number) =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= limit);
const pullSchema = z.looseObject({
  number: z.number().int().min(1).max(2147483647),
  title: providerString(1024),
  html_url: providerString(1000),
  merged: z.boolean(),
  state: z.enum(["open", "closed"]),
  head: z.looseObject({ ref: providerString(1024), sha: z.string().regex(/^[a-f0-9]{40}$/) }),
  base: z.looseObject({
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    repo: z.looseObject({
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      full_name: providerString(500),
    }),
  }),
});
export type Pull = z.infer<typeof pullSchema>;
export function checkedPull(input: unknown): Pull {
  const parsed = pullSchema.safeParse(input);
  if (!parsed.success)
    throw new GitHubRequestError(
      "GitHub returned invalid or oversized pull request metadata.",
      502,
    );
  const pull = parsed.data;
  const location = parsePullUrl(pull.html_url);
  if (location.repository !== pull.base.repo.full_name || location.number !== pull.number)
    throw new GitHubRequestError("GitHub returned inconsistent pull request metadata.");
  return pull;
}

export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const linkSchema = z
  .object({
    url: z.string().max(500),
    frameIds: z.array(z.string().min(1).max(120)).min(1).max(100),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export const captureSchema = z
  .object({
    frameId: z.string().min(1).max(120),
    sha: shaSchema,
    route: z.string().startsWith("/").max(500),
    width: z.number().int().min(1).max(5000),
    height: z.number().int().min(1).max(5000),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: z.string().min(1).max(2800000),
  })
  .strict();
export const feedbackSchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
    sha: shaSchema,
    nodeId: z.string().max(120).optional(),
    captureId: z.string().uuid().optional(),
    point: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .strict()
      .optional(),
  })
  .strict();
export const responseSchema = z
  .object({
    feedbackId: z.string().uuid(),
    sha: shaSchema,
    body: z.string().trim().min(1).max(2000),
  })
  .strict();
export function parsePullUrl(value: string) {
  const url = new URL(value);
  const match = url.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/,
  );
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    !match ||
    !Number.isSafeInteger(Number(match[3]))
  )
    throw new GitHubRequestError("Enter a GitHub pull request URL.");
  return { repository: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}
export function snapshotFrames(content: DesignDocument, frameIds: string[]) {
  const frames = [...new Set(frameIds)].sort();
  const frameSet = new Set(
    content.nodes.filter((node) => node.type === "artboard").map((node) => node.id),
  );
  if (frames.some((id) => !frameSet.has(id)))
    throw new GitHubRequestError("Choose existing frames to link.");
  const included = new Set(frames);
  const children = new Map<string, string[]>();
  for (const node of content.nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const pending = [...frames];
  for (let index = 0; index < pending.length; index++) {
    for (const child of children.get(pending[index]) ?? []) {
      if (included.has(child)) continue;
      included.add(child);
      pending.push(child);
    }
  }
  // Freeze external component sources at their selected appearance and remove external navigation.
  return {
    ...content,
    nodes: removeComponentReferences(
      content.nodes,
      new Set(content.nodes.filter((node) => !included.has(node.id)).map((node) => node.id)),
    ),
    editedNodeIds: content.editedNodeIds.filter((id) => included.has(id)),
    commentPages: {},
  };
}
export function captureBytes(base64: string, mimeType: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
    throw new GitHubRequestError("Provide valid base64 image bytes.");
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > 2 * 1024 * 1024)
    throw new GitHubRequestError("Captures must be at most 2 MB.");
  const valid =
    mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new GitHubRequestError("Image bytes do not match the selected format.");
  return bytes;
}
export function safePreviewUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
