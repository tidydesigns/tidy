import type { DraftStore } from "./draft-store";
import type { Draft } from "./machine-context";
import { errorMessage } from "@tidy/ui/errors";
import type { CloudAPI } from "../../../../shared/contracts/cloud-sync";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import { draftImportSchema } from "../../../../shared/contracts/draft-import";

export type CloudDesignReference = {
  accountId: string;
  organizationId: string;
  fileId: string;
  name: string;
};

export type DraftCloudReference = CloudDesignReference & { token: string } & (
    | { kind: "pending" }
    | { kind: "ready"; designId: string }
    | { kind: "error"; message: string }
  );

export const cloudReferenceKey = (reference: CloudDesignReference) =>
  JSON.stringify([reference.accountId, reference.organizationId, reference.fileId]);

export async function importCloudReference({
  source,
  target,
  projectId,
  reference,
  isCurrent,
}: {
  source: { cloud?: Pick<CloudAPI, "state" | "exportReference"> };
  target: Pick<DesktopAPI, "importDraft">;
  projectId: string;
  reference: CloudDesignReference;
  isCurrent(): boolean;
}) {
  const cloud = source.cloud;
  const importDraft = target.importDraft;
  if (!cloud?.exportReference || !importDraft)
    throw new Error("Update Tidy on both machines to use cloud design references.");
  const assertCurrent = async () => {
    if (!isCurrent()) throw new DOMException("Reference removed", "AbortError");
    const state = await cloud.state();
    if (!state.signedIn || state.accountId !== reference.accountId)
      throw new Error("The cloud account changed. Select this design again.");
    if (!isCurrent()) throw new DOMException("Reference removed", "AbortError");
  };
  await assertCurrent();
  const design = await cloud.exportReference(reference.organizationId, reference.fileId);
  await assertCurrent();
  const input = draftImportSchema.parse({ projectId, attachments: [], designs: [design] });
  const result = await importDraft(input);
  await assertCurrent();
  const designId = result.designIds[0];
  if (!designId || result.designIds.length !== 1 || result.snapshot.project.id !== projectId)
    throw new Error("The reference was not imported. Try again.");
  return { designId, snapshot: result.snapshot };
}

type ReferenceImportResult = Awaited<ReturnType<typeof importCloudReference>>;
type ReferenceImport =
  | { kind: "pending"; promise: Promise<ReferenceImportResult> }
  | { kind: "ready"; promise: Promise<ReferenceImportResult>; completedAt: number };

export class CloudReferenceImports {
  private imports = new Map<string, ReferenceImport>();
  constructor(private now: () => number = Date.now) {}
  prepare(
    input: Parameters<typeof importCloudReference>[0] & { machineId: string; draftKey: string },
  ) {
    const key = JSON.stringify([
      input.machineId,
      input.projectId,
      input.draftKey,
      cloudReferenceKey(input.reference),
    ]);
    const existing = this.imports.get(key);
    if (existing && (existing.kind === "pending" || this.now() - existing.completedAt < 30_000))
      return existing.promise;
    const work = importCloudReference(input);
    this.imports.set(key, { kind: "pending", promise: work });
    void work.then(
      () => {
        this.imports.set(key, { kind: "ready", promise: work, completedAt: this.now() });
        if (this.imports.size > 200) {
          const first = [...this.imports].find(([, entry]) => entry.kind === "ready")?.[0];
          if (first) this.imports.delete(first);
        }
      },
      () => {
        if (this.imports.get(key)?.promise === work) this.imports.delete(key);
      },
    );
    return work;
  }
}

type ReferenceSelection = {
  store: DraftStore;
  machineId: string;
  draftKey: string;
  projectId: string;
  fallback: Draft;
  source: Parameters<typeof importCloudReference>[0]["source"];
  target: Parameters<typeof importCloudReference>[0]["target"];
};

function prepareReference(
  input: ReferenceSelection,
  reference: CloudDesignReference,
  token: string,
) {
  const { store, machineId, draftKey } = input;
  const referenceKey = cloudReferenceKey(reference);
  const isCurrent = () =>
    store
      .get(machineId)
      [draftKey]?.cloudReferences?.some((item) => cloudReferenceKey(item) === referenceKey) ??
    false;
  const update = (result: DraftCloudReference) =>
    store.update(machineId, (current) => {
      const draft = current[draftKey];
      if (!draft?.cloudReferences?.some((item) => item.token === token && item.kind === "pending"))
        return current;
      return {
        ...current,
        [draftKey]: {
          ...draft,
          cloudReferences: draft.cloudReferences.map((item) =>
            item.token === token ? result : item,
          ),
        },
      };
    });
  void store.references.prepare({ ...input, reference, isCurrent }).then(
    (result) => {
      if (
        !store
          .get(machineId)
          [draftKey]?.cloudReferences?.some(
            (item) => item.token === token && item.kind === "pending",
          )
      )
        return;
      update({ ...reference, token, kind: "ready", designId: result.designId });
    },
    (cause: unknown) => {
      update({
        ...reference,
        token,
        kind: "error",
        message: errorMessage(cause, "Could not prepare this reference. Try again."),
      });
    },
  );
}

export function toggleProjectCloudReference(
  input: ReferenceSelection & { reference: CloudDesignReference },
) {
  const { store, machineId, draftKey, reference } = input;
  const draft = store.get(machineId)[draftKey] ?? input.fallback;
  const key = cloudReferenceKey(reference);
  const existing = draft.cloudReferences?.find((item) => cloudReferenceKey(item) === key);
  if (existing) {
    store.update(machineId, (current) => ({
      ...current,
      [draftKey]: {
        ...(current[draftKey] ?? draft),
        cloudReferences: draft.cloudReferences?.filter((item) => item.token !== existing.token),
      },
    }));
    return;
  }
  if (
    draft.designIds.length +
      (draft.cloudFileIds?.length ?? 0) +
      (draft.cloudReferences?.length ?? 0) >=
    20
  )
    return;
  const token = crypto.randomUUID();
  store.update(machineId, (current) => ({
    ...current,
    [draftKey]: {
      ...(current[draftKey] ?? draft),
      cloudReferences: [...(draft.cloudReferences ?? []), { ...reference, token, kind: "pending" }],
    },
  }));
  prepareReference(input, reference, token);
}

export function retryProjectCloudReference(input: ReferenceSelection & { token: string }) {
  const { store, machineId, draftKey } = input;
  const draft = store.get(machineId)[draftKey];
  const reference = draft?.cloudReferences?.find((item) => item.token === input.token);
  if (!reference || reference.kind !== "error") return;
  const token = crypto.randomUUID();
  store.update(machineId, (current) => ({
    ...current,
    [draftKey]: {
      ...current[draftKey],
      cloudReferences: current[draftKey].cloudReferences?.map((item) =>
        item.token === input.token ? { ...reference, token, kind: "pending" } : item,
      ),
    },
  }));
  prepareReference(input, reference, token);
}
