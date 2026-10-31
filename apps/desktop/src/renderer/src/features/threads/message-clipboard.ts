import { z } from "zod";
import {
  attachmentSchema,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  type AttachedFile,
} from "../../../../shared/contracts/attachments";
import type { DesktopAPI, Message } from "../../../../shared/contracts/desktop";
import { machineIdSchema } from "../../../../shared/remote";
import {
  attachmentParts,
  attachmentReference,
} from "../../../../shared/models/attachment-references";

export const MESSAGE_CLIPBOARD_MIME = "web application/x-tidy-message+json";
const maxFragmentLength = 1_100_000;
const clipboardMessageSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        clientId: z.string().uuid(),
        machineId: machineIdSchema,
        projectId: z.string().uuid(),
      })
      .strict(),
    text: z.string().max(1_000_000),
    attachments: z.array(attachmentSchema.strict()).max(MAX_ATTACHMENTS),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.attachments.map((file) => file.id)).size === value.attachments.length &&
      value.attachments.reduce((total, file) => total + file.size, 0) <= MAX_ATTACHMENT_TOTAL_BYTES,
  );
export type ClipboardMessage = z.infer<typeof clipboardMessageSchema>;
let cachedClientId: string | undefined;
export function clipboardClientId() {
  if (cachedClientId) return cachedClientId;
  try {
    const stored = localStorage.getItem("clipboard-client-id");
    if (stored && z.string().uuid().safeParse(stored).success) return (cachedClientId = stored);
    const id = crypto.randomUUID();
    localStorage.setItem("clipboard-client-id", id);
    return (cachedClientId = id);
  } catch {
    return (cachedClientId = crypto.randomUUID());
  }
}

const referenceStorageKey = "clipboard-image-references";
const referenceSchema = z
  .object({
    source: clipboardMessageSchema.shape.source,
    attachment: attachmentSchema.strict(),
  })
  .strict();
const referencesSchema = z.array(referenceSchema).max(500);
type ClipboardStorage = Pick<Storage, "getItem" | "setItem">;
function clipboardStorage(): ClipboardStorage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}
function imageReferences(storage: ClipboardStorage | undefined) {
  try {
    const raw = storage?.getItem(referenceStorageKey) ?? "[]";
    if (raw.length > 1_000_000) return [];
    return referencesSchema.parse(JSON.parse(raw));
  } catch {
    return [];
  }
}
function rememberImages(message: ClipboardMessage, storage: ClipboardStorage | undefined) {
  const images = message.attachments.filter((file) => file.mimeType.startsWith("image/"));
  if (!images.length) return;
  const ids = new Set(images.map((file) => file.id));
  const entries = imageReferences(storage).filter((entry) => !ids.has(entry.attachment.id));
  try {
    storage?.setItem(
      referenceStorageKey,
      JSON.stringify(
        [...entries, ...images.map((attachment) => ({ source: message.source, attachment }))].slice(
          -500,
        ),
      ),
    );
  } catch {}
}
function imageMarkdown(file: ClipboardMessage["attachments"][number]) {
  const name = file.name.replace(/[\r\n]/g, " ").replace(/[\\[\]]/g, "\\$&");
  return `![${name}](tidy-context://v1/image/${file.id})`;
}
export function messageClipboardText(message: Pick<Message, "text" | "attachments">) {
  const attachments = message.attachments ?? [];
  const included = new Set<string>();
  const label = (file: ClipboardMessage["attachments"][number]) =>
    file.mimeType.startsWith("image/") ? imageMarkdown(file) : file.name;
  const text = attachmentParts(message.text, attachments)
    .map((part) => {
      if (part.kind === "text") return part.text;
      included.add(part.file.id);
      return label(part.file);
    })
    .join("");
  return [text, ...attachments.filter((file) => !included.has(file.id)).map(label)]
    .filter(Boolean)
    .join("\n");
}
function readImageReferences(text: string, storage: ClipboardStorage | undefined) {
  if (text.length > maxFragmentLength || !text.includes("tidy-context://v1/image/")) return null;
  const references = new Map(imageReferences(storage).map((entry) => [entry.attachment.id, entry]));
  const files = new Map<string, ClipboardMessage["attachments"][number]>();
  let source: ClipboardMessage["source"] | undefined;
  let invalid = false;
  const restored = text.replace(
    /!\[(?:\\.|[^\]\\\r\n])*\]\(tidy-context:\/\/v1\/image\/([0-9a-f-]{36})\)/g,
    (markdown, id: string) => {
      const entry = references.get(id);
      if (
        !entry ||
        entry.source.clientId !== clipboardClientId() ||
        (source &&
          (source.machineId !== entry.source.machineId ||
            source.projectId !== entry.source.projectId))
      ) {
        invalid = true;
        return markdown;
      }
      source = entry.source;
      files.set(id, entry.attachment);
      return attachmentReference(entry.attachment);
    },
  );
  if (invalid || !source || !files.size) return null;
  const parsed = clipboardMessageSchema.safeParse({
    version: 1,
    source,
    text: restored,
    attachments: [...files.values()],
  });
  return parsed.success ? parsed.data : null;
}

export function messageClipboardContent({
  message,
  projectId,
  machineId = "local",
  clientId = clipboardClientId(),
  storage = clipboardStorage(),
}: {
  message: Pick<Message, "text" | "attachments">;
  projectId: string;
  machineId?: string;
  clientId?: string;
  storage?: ClipboardStorage;
}) {
  const fragment = clipboardMessageSchema.parse({
    version: 1,
    source: { clientId, machineId, projectId },
    text: message.text,
    attachments: (message.attachments ?? []).map((file) => attachmentSchema.parse(file)),
  });
  const encoded = JSON.stringify(fragment);
  if (encoded.length > maxFragmentLength) throw new Error("This message is too large to copy.");
  rememberImages(fragment, storage);
  const text = messageClipboardText(message);
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    text,
    encoded,
    html: `<pre data-tidy-message="${encodeURIComponent(encoded)}">${escaped}</pre>`,
  };
}

export function decodeMessageClipboard(raw: string) {
  if (!raw || raw.length > maxFragmentLength) return null;
  try {
    const parsed = clipboardMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readMessageClipboard(
  data: Pick<DataTransfer, "getData">,
  storage = clipboardStorage(),
) {
  let fragment = decodeMessageClipboard(data.getData(MESSAGE_CLIPBOARD_MIME));
  if (!fragment) {
    const html = data.getData("text/html");
    if (html.length <= maxFragmentLength * 9 + 4096) {
      const match = /data-tidy-message=(?:"([^"]+)"|'([^']+)')/.exec(html);
      try {
        fragment = decodeMessageClipboard(decodeURIComponent(match?.[1] ?? match?.[2] ?? ""));
      } catch {}
    }
  }
  const plain = data.getData("text/plain");
  if (!fragment || fragment.source.clientId !== clipboardClientId())
    return readImageReferences(plain, storage);
  const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
  return normalize(plain) === normalize(messageClipboardText(fragment))
    ? fragment
    : readImageReferences(plain, storage);
}

export async function copyMessage(input: Parameters<typeof messageClipboardContent>[0]) {
  if (!input.message.attachments?.length)
    return navigator.clipboard.writeText(messageClipboardText(input.message));
  const value = messageClipboardContent(input);
  const plain = new Blob([value.text], { type: "text/plain" });
  const html = new Blob([value.html], { type: "text/html" });
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": plain,
        "text/html": html,
        [MESSAGE_CLIPBOARD_MIME]: new Blob([value.encoded], {
          type: "application/x-tidy-message+json",
        }),
      }),
    ]);
  } catch {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": plain, "text/html": html }),
    ]);
  }
}

export async function importMessageAttachment({
  source,
  target,
  message,
  file,
  projectId,
  signal,
  isRetained = () => true,
}: {
  source: Pick<DesktopAPI, "exportAttachment">;
  target: Pick<DesktopAPI, "addAttachment">;
  message: ClipboardMessage;
  file: ClipboardMessage["attachments"][number];
  projectId: string;
  signal: AbortSignal;
  isRetained?(): boolean;
}): Promise<AttachedFile> {
  function check() {
    signal.throwIfAborted();
    if (!isRetained())
      throw new DOMException("The attachment was removed from the draft.", "AbortError");
  }
  check();
  if (!source.exportAttachment) throw new Error("The source machine cannot export attachments.");
  const value = await source.exportAttachment(message.source.projectId, file.id);
  check();
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value.dataUrl);
  const padding = match?.[2].endsWith("==") ? 2 : match?.[2].endsWith("=") ? 1 : 0;
  if (!match || match[1] !== file.mimeType || (match[2].length / 4) * 3 - padding !== file.size)
    throw new Error("The original attachment no longer matches the copied message.");
  const imported = await target.addAttachment(projectId, value.name, value.dataUrl);
  check();
  return imported;
}
