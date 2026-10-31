import { z } from "zod";
import {
  attachmentSchema,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  type AttachedFile,
} from "../../../../shared/contracts/attachments";
import type { DesktopAPI, Message } from "../../../../shared/contracts/desktop";
import { machineIdSchema } from "../../../../shared/remote";
import { attachmentText } from "../../../../shared/models/attachment-references";

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

export function messageClipboardText(message: Pick<Message, "text" | "attachments">) {
  const attachments = message.attachments ?? [];
  const text = attachmentText(message.text, attachments);
  const extra = attachments.filter((file) => !message.text.includes(`[[attachment:${file.id}]]`));
  return [text, ...extra.map((file) => file.name)].filter(Boolean).join("\n");
}

export function messageClipboardContent({
  message,
  projectId,
  machineId = "local",
  clientId = clipboardClientId(),
}: {
  message: Pick<Message, "text" | "attachments">;
  projectId: string;
  machineId?: string;
  clientId?: string;
}) {
  const fragment = clipboardMessageSchema.parse({
    version: 1,
    source: { clientId, machineId, projectId },
    text: message.text,
    attachments: (message.attachments ?? []).map((file) => attachmentSchema.parse(file)),
  });
  const encoded = JSON.stringify(fragment);
  if (encoded.length > maxFragmentLength) throw new Error("This message is too large to copy.");
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

export function readMessageClipboard(data: Pick<DataTransfer, "getData">) {
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
  if (!fragment || fragment.source.clientId !== clipboardClientId()) return null;
  const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
  return normalize(data.getData("text/plain")) === normalize(messageClipboardText(fragment))
    ? fragment
    : null;
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
