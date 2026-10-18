import { useCallback, useEffect, useRef, useState } from "react";
import { FileEditor } from "@tidy/editor";
import { EditorHostProvider } from "@tidy/editor/host";
import type { DesignDocument } from "@tidy/design/document";
import type { DesktopAPI, LocalDesign } from "../../shared/contracts";

/** The canvas owns gestures/history; this adapter owns only local persistence. */
export function LocalCanvas({
  api,
  projectId,
  initial,
  active,
  onBack,
  onUpdate,
}: {
  api: DesktopAPI;
  projectId: string;
  initial: LocalDesign;
  active: boolean;
  onBack(): void;
  onUpdate(design: LocalDesign): void;
}) {
  const file = useRef(initial);
  const revision = useRef(0);
  const pending = useRef(0);
  const writes = useRef(Promise.resolve());
  const refreshWanted = useRef(false);
  const refreshEpoch = useRef(0);
  const [assets, setAssets] = useState(initial.assets);
  const [external, setExternal] = useState<{ revision: number; content: DesignDocument }>();
  const notify = useRef(onUpdate);
  notify.current = onUpdate;
  const refresh = useCallback(async () => {
    refreshWanted.current = true;
    if (pending.current) return;
    refreshWanted.current = false;
    const epoch = ++refreshEpoch.current;
    const value = await api.readDesign(projectId, initial.id);
    if (pending.current || epoch !== refreshEpoch.current) {
      refreshWanted.current = true;
      return;
    }
    if (value.version === file.current.version) return;
    file.current = value;
    setAssets(value.assets);
    setExternal({ revision: ++revision.current, content: value.document });
    notify.current(value);
  }, [api, projectId, initial.id]);
  useEffect(() => {
    void refresh().catch(console.error);
    return api.onEvent((event) => {
      if (
        event.type === "designs" &&
        event.projectId === projectId &&
        event.designs.some(
          (design) => design.id === initial.id && design.updatedAt !== file.current.updatedAt,
        )
      )
        void refresh().catch(console.error);
    });
  }, [api, projectId, initial.id, refresh]);

  async function update(changes: { document?: DesignDocument; name?: string }) {
    pending.current++;
    refreshEpoch.current++;
    const write = writes.current.then(async () => {
      const value = await api.updateDesign({
        projectId,
        designId: initial.id,
        expectedVersion: file.current.version,
        ...changes,
      });
      file.current = value;
      setAssets(value.assets);
      revision.current++;
      notify.current(value);
    });
    writes.current = write.catch(() => {});
    try {
      await write;
    } catch (error) {
      refreshWanted.current = true;
      throw error;
    } finally {
      pending.current--;
      if (refreshWanted.current) void refresh().catch(console.error);
    }
  }

  return (
    <EditorHostProvider
      value={{
        Link: function BackLink({ children, className, onNavigate }) {
          return (
            <button
              className={className}
              aria-label="Back to designs"
              onClick={() => {
                let blocked = false;
                onNavigate?.({
                  preventDefault() {
                    blocked = true;
                  },
                });
                if (!blocked) onBack();
              }}
            >
              {children}
            </button>
          );
        },
      }}
    >
      <FileEditor
        fileId={initial.id}
        fileName={initial.name}
        organizationName=""
        backHref="#"
        initialDocument={{ revision: 0, content: initial.document }}
        initialPanelsOpen
        local
        active={active}
        previewAssetUrls={assets}
        externalDocument={external}
        localPersistence={{
          async loadLibrary(source) {
            const id =
              source
                .trim()
                .split("/")
                .at(-1)
                ?.replace(/\.json$/, "") ?? source;
            const value = await api.readDesign(projectId, id);
            setAssets((current) => ({ ...current, ...value.assets }));
            return {
              fileUid: value.id,
              name: value.name,
              revision: new Date(value.updatedAt).getTime(),
              content: value.document,
            };
          },
          commit: (document) => update({ document }),
          rename: (name) => update({ name }),
          async uploadAsset(file) {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(new Error("Could not read this image."));
              reader.readAsDataURL(file);
            });
            const value = await api.uploadDesignAsset(projectId, dataUrl);
            setAssets((current) => ({ ...current, [value.assetId]: value.url }));
            return value;
          },
        }}
      />
    </EditorHostProvider>
  );
}
