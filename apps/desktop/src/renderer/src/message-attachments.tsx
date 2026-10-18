import { useEffect, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { AttachedFile, Attachment } from "../../shared/attachments";
import type { DesktopAPI } from "../../shared/contracts";
export const attachmentSize = (size: number) =>
  size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : size >= 1024
      ? `${Math.ceil(size / 1024)} KB`
      : `${size} B`;
export function AttachmentList({
  files,
  onRemove,
}: {
  files: AttachedFile[];
  onRemove?: (id: string) => void;
}) {
  if (!files.length) return null;
  return (
    <ul className="message-attachments" aria-label="Attachments">
      {files.map((file) => (
        <li className="message-attachment" key={file.id}>
          {file.previewUrl ? (
            <img src={file.previewUrl} alt={file.name} />
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" width="24" height="24">
              <path
                d="M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6m-6 4h6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span className="attachment-label">
            <span title={file.name}>{file.name}</span>
            <small>{attachmentSize(file.size)}</small>
          </span>
          {onRemove && (
            <Button
              type="button"
              className="attachment-remove"
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
          if (current && value.previewUrl)
            setPreviews((previous) => ({ ...previous, [id]: value.previewUrl! }));
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
