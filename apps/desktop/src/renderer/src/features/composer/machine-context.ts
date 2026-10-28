import { UserFacingError } from "@tidy/ui/errors";
import type {
  Bootstrap,
  DesktopAPI,
  Project,
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
};
export type PreparedWorkspace = {
  bootstrap: Bootstrap;
  draft?: Draft;
  relation: "matching" | "separate";
};

export async function copyDraft({
  api,
  source,
  target,
  projectId,
  signal,
}: {
  api: Pick<DesktopAPI, "exportAttachment" | "exportDesign">;
  source: MachineSelection;
  target: Pick<DesktopAPI, "addAttachment" | "uploadDesignAsset" | "createDesign" | "updateDesign">;
  projectId: string;
  signal?: AbortSignal;
}): Promise<Draft> {
  signal?.throwIfAborted();
  const attachments = [];
  for (const attachment of source.draft.attachments ?? []) {
    if (!api.exportAttachment)
      throw new UserFacingError("Update Tidy on the source machine to copy attachments.");
    signal?.throwIfAborted();
    const file = await api.exportAttachment(source.contextProjectId, attachment.id);
    signal?.throwIfAborted();
    attachments.push(await target.addAttachment(projectId, file.name, file.dataUrl));
  }
  const designIds: string[] = [];
  for (const id of source.draft.designIds) {
    if (!api.exportDesign)
      throw new UserFacingError("Update Tidy on the source machine to copy design references.");
    signal?.throwIfAborted();
    const design = await api.exportDesign(source.contextProjectId, id);
    const assets = new Map<string, string>();
    for (const [assetId, dataUrl] of Object.entries(design.assets)) {
      signal?.throwIfAborted();
      const imported = await target.uploadDesignAsset(projectId, dataUrl);
      assets.set(assetId, imported.assetId);
    }
    const { parseDesignDocument } = await import("@tidy/design/document");
    const document = parseDesignDocument(
      JSON.parse(
        JSON.stringify(design.document, (key, value: unknown) =>
          key === "assetId" && typeof value === "string" ? (assets.get(value) ?? value) : value,
        ),
      ),
    );
    signal?.throwIfAborted();
    const created = await target.createDesign(projectId);
    signal?.throwIfAborted();
    const imported = await target.updateDesign({
      projectId,
      designId: created.id,
      expectedVersion: created.version,
      name: design.name,
      document,
    });
    designIds.push(imported.id);
  }
  return {
    ...source.draft,
    attachments,
    designIds,
    cloudFileIds: undefined,
    executionProjectId: undefined,
    skill: undefined,
  };
}
