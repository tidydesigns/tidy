import { UserFacingError } from "@tidy/ui/errors";
import type { AttachedFile } from "../../../../shared/contracts/attachments";

export function restoreDraftAttachments({
  attachments,
  isPending,
}: {
  attachments: AttachedFile[];
  isPending(id: string): boolean;
}): AttachedFile[] {
  return attachments.map((file) =>
    file.importState === "pending" && !isPending(file.id)
      ? { ...file, importState: "failed" }
      : file,
  );
}

export function assertAttachmentsReady(attachments: AttachedFile[]) {
  if (attachments.some((file) => file.importState))
    throw new UserFacingError(
      "Wait for attachments to load, or remove failed attachments, before moving this draft.",
    );
}
