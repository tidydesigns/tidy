import {
  draftImportSchema,
  MAX_DRAFT_IMPORT_BYTES,
} from "../../../../shared/contracts/draft-import";
import { remapAttachmentReferences } from "../../../../shared/models/attachment-references";
import { UserFacingError } from "@tidy/ui/errors";
import type {
  Bootstrap,
  Thread,
  DesktopAPI,
  Project,
  ProjectSnapshot,
  HarnessId,
} from "../../../../shared/contracts/desktop";
import type { AttachedFile } from "../../../../shared/contracts/attachments";
import type { HarnessSettings } from "../../../../shared/contracts/harness-settings";
import type { WorkspaceMachine } from "../../../../shared/remote";
export type Draft = {
  text: string;
  harness: HarnessId;
  designIds: string[];
  cloudFileIds?: string[];
  executionProjectId?: string;
  settings?: HarnessSettings;
  attachments?: AttachedFile[];
  skill?: { id: string; name: string; harness: HarnessId };
};

export type MachineSelection = { project: Project; contextProjectId: string; draft: Draft };
export type MachineContext = {
  current: WorkspaceMachine;
  machines: WorkspaceMachine[];
  connected: boolean;
  switching: boolean;
  select(id: string, source: MachineSelection): void;
  navigate(id: string): void;
  cancelProjectNavigation(): void;
  projects(id: string, refresh?: boolean): Promise<Project[]>;
  openProject(id: string, projectId?: string): Promise<void>;
  removeProject?(id: string, projectId: string): Promise<void>;
};
export type PreparedWorkspace = {
  bootstrap: Bootstrap;
  threads?: Thread[];
  draft?: Draft;
  relation: "matching" | "separate";
};

export async function copyDraft({
  api,
  source,
  target,
  projectId,
  signal,
  onImport,
}: {
  api: Pick<DesktopAPI, "exportAttachment" | "exportDesign">;
  source: MachineSelection;
  target: Pick<DesktopAPI, "importDraft">;
  projectId: string;
  signal?: AbortSignal;
  onImport?(): void;
}): Promise<{ draft: Draft; snapshot: ProjectSnapshot | null }> {
  signal?.throwIfAborted();
  const attachments = [];
  const designs = [];
  let size = 0;
  function bound(value: unknown) {
    size += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (size > MAX_DRAFT_IMPORT_BYTES)
      throw new UserFacingError(
        "These references are too large to move together. Remove some references and try again.",
      );
  }
  for (const attachment of source.draft.attachments ?? []) {
    if (!api.exportAttachment)
      throw new UserFacingError("Update Tidy on the source machine to copy attachments.");
    const file = await api.exportAttachment(source.contextProjectId, attachment.id);
    signal?.throwIfAborted();
    bound(file);
    attachments.push(file);
  }
  for (const id of source.draft.designIds) {
    if (!api.exportDesign)
      throw new UserFacingError("Update Tidy on the source machine to copy design references.");
    const { name, document, assets } = await api.exportDesign(source.contextProjectId, id);
    signal?.throwIfAborted();
    const design = { name, document, assets };
    bound(design);
    designs.push(design);
  }
  signal?.throwIfAborted();
  let imported;
  if (attachments.length || designs.length) {
    const importDraft = target.importDraft;
    if (!importDraft)
      throw new UserFacingError(
        "Update Tidy on the destination machine to copy references safely.",
      );
    const input = draftImportSchema.safeParse({ projectId, attachments, designs });
    if (!input.success)
      throw new UserFacingError(
        input.error.issues[0]?.message ?? "These references could not be copied.",
      );
    onImport?.();
    imported = await importDraft(input.data);
  }
  return {
    snapshot: imported?.snapshot ?? null,
    draft: {
      ...source.draft,
      text: remapAttachmentReferences({
        text: source.draft.text,
        source: source.draft.attachments ?? [],
        target: imported?.attachments ?? [],
      }),
      attachments: imported?.attachments ?? [],
      designIds: imported?.designIds ?? [],
      cloudFileIds: undefined,
      executionProjectId: undefined,
      skill: undefined,
    },
  };
}
