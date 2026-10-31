import { ImagePreview } from "../../components/chat-image";
import { Fragment, useEffect, useState } from "react";
import { attachmentParts } from "../../../../shared/models/attachment-references";
import { Button } from "@tidy/ui/button";
import type { AttachedFile, Attachment } from "../../../../shared/contracts/attachments";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
export const attachmentSize = (size: number) =>
  size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : size >= 1024
      ? `${Math.ceil(size / 1024)} KB`
      : `${size} B`;
export const attachmentReferenceClassName =
  "attachment-reference inline-flex max-w-[min(220px,100%)] items-baseline gap-1 overflow-hidden rounded-[5px] border border-border bg-panel px-[5px] align-baseline text-xs leading-5 text-ellipsis whitespace-nowrap text-ink select-all before:text-muted-ink before:content-['▧']";

export function AttachmentList({
  files,
  onRemove,
}: {
  files: AttachedFile[];
  onRemove?: (id: string) => void;
}) {
  if (!files.length) return null;
  return (
    <ul
      className="message-attachments mt-2 mb-3 flex list-none flex-wrap gap-2 p-0"
      aria-label="Attachments"
    >
      {files.map((file) => (
        <li
          className={`message-attachment flex max-w-60 items-center gap-[9px] rounded-lg border border-border bg-panel text-ink ${file.previewUrl ? "message-attachment-image relative size-18 min-h-0 p-0" : "min-h-12 px-2 py-1.5"}`}
          key={file.referenceId ?? file.id}
          title={file.name}
        >
          {file.previewUrl ? (
            <ImagePreview key={file.previewUrl} src={file.previewUrl} name={file.name} compact />
          ) : (
            <svg
              className="shrink-0 text-muted-ink"
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              width="24"
              height="24"
            >
              <path
                d="M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6m-6 4h6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {!file.previewUrl && (
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="truncate text-xs" title={file.name}>
                {file.name}
              </span>
              <small className="text-[11px] text-muted-ink">{attachmentSize(file.size)}</small>
            </span>
          )}
          {onRemove && (
            <Button
              type="button"
              className={`attachment-remove shrink-0 cursor-pointer rounded px-[5px] py-px text-[17px] leading-5 text-muted-ink hover:bg-hover-surface ${file.previewUrl ? "absolute top-[3px] right-[3px] border border-border bg-(--desktop-surface)" : "border-0 bg-transparent"}`}
              aria-label={`Remove ${file.name}`}
              onClick={() => onRemove(file.id)}
            >
              ×
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
export function MessageAttachments({
  api,
  projectId,
  files,
}: {
  api: DesktopAPI;
  projectId: string;
  files: Attachment[];
}) {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const imageIds = JSON.stringify(
    files.filter((file) => file.mimeType.startsWith("image/")).map((file) => file.id),
  );
  useEffect(() => {
    let current = true;
    for (const id of JSON.parse(imageIds) as string[])
      void api
        .readAttachment(projectId, id)
        .then((value) => {
          const previewUrl = value.previewUrl;
          if (current && previewUrl) setPreviews((previous) => ({ ...previous, [id]: previewUrl }));
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, projectId, imageIds]);
  return (
    <AttachmentList files={files.map((file) => ({ ...file, previewUrl: previews[file.id] }))} />
  );
}

export function AttachmentText({ text, files }: { text: string; files: AttachedFile[] }) {
  return attachmentParts(text, files).map((part, index) =>
    part.kind === "text" ? (
      <Fragment key={index}>{part.text}</Fragment>
    ) : (
      <span
        key={index}
        className={attachmentReferenceClassName}
        title={`${part.file.name} · ${attachmentSize(part.file.size)}`}
      >
        {part.file.name}
      </span>
    ),
  );
}
