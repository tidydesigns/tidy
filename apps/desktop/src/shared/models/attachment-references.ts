import type { AttachedFile, Attachment } from "../contracts/attachments";

export const attachmentReference = (file: Pick<AttachedFile, "id" | "referenceId">) =>
  `[[attachment:${file.referenceId ?? file.id}]]`;

export function attachmentParts(text: string, files: AttachedFile[]) {
  const byId = new Map(
    files.flatMap((file) => [
      [file.id, file] as const,
      [file.referenceId ?? file.id, file] as const,
    ]),
  );
  const parts: (
    | { kind: "text"; text: string }
    | { kind: "attachment"; file: AttachedFile; referenceId: string }
  )[] = [];
  let start = 0;
  for (const match of text.matchAll(/\[\[attachment:([0-9a-f-]{36})\]\]/g)) {
    const file = byId.get(match[1]);
    if (!file) continue;
    if (match.index > start) parts.push({ kind: "text", text: text.slice(start, match.index) });
    parts.push({ kind: "attachment", file, referenceId: match[1] });
    start = match.index + match[0].length;
  }
  if (start < text.length) parts.push({ kind: "text", text: text.slice(start) });
  return parts;
}

export function resolveAttachmentReferences(text: string, files: AttachedFile[]) {
  return attachmentParts(text, files)
    .map((part) => (part.kind === "text" ? part.text : attachmentReference({ id: part.file.id })))
    .join("");
}

export function removeAttachmentReference(
  text: string,
  file: Pick<AttachedFile, "id" | "referenceId">,
) {
  return text
    .replaceAll(attachmentReference(file), "")
    .replaceAll(attachmentReference({ id: file.id }), "");
}

export function remapAttachmentReferences({
  text,
  source,
  target,
}: {
  text: string;
  source: AttachedFile[];
  target: Attachment[];
}) {
  return attachmentParts(text, source)
    .map((part) => {
      if (part.kind === "text") return part.text;
      const file = target[source.indexOf(part.file)];
      return file ? attachmentReference(file) : "";
    })
    .join("");
}

export function attachmentText(text: string, files: AttachedFile[]) {
  return attachmentParts(text, files)
    .map((part) => (part.kind === "text" ? part.text : part.file.name))
    .join("");
}
