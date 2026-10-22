import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileEditor } from "@tidy/editor";
import { EditorHostProvider, type EditorLinkProps } from "@tidy/editor/host";
import type { DesignDocument } from "@tidy/design/document";
import type { DesktopAPI, LocalDesign } from "../../shared/contracts";

export const LocalCanvas = memo(function LocalCanvas({
  api,
  projectId,
  initial,
  active,
  onBack,
  onUpdate,
  status,
  backLabel = "Back to designs",
  initialPanelsOpen = true,
}: {
  api: DesktopAPI;
  projectId: string;
  initial: LocalDesign;
  active: boolean;
  onBack(): void;
  onUpdate(design: LocalDesign): void;
  status?: ReactNode;
  backLabel?: string;
  initialPanelsOpen?: boolean;
}) {
  useEffect(() => {
    if (!active || !api.cloud) return;
    const focus = () => {
      if (!document.hidden) void api.cloud?.focus(projectId, initial.id).catch(() => {});
    };
    focus();
    window.addEventListener("focus", focus);
    window.addEventListener("online", focus);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", focus);
      void api.cloud?.focus().catch(() => {});
    };
  }, [api, projectId, initial.id, active]);
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

  const back = useRef(onBack);
  back.current = onBack;
  const host = useMemo(
    () => ({
      Link: function BackLink({ children, className, onNavigate }: EditorLinkProps) {
        return (
          <button
            className={className}
            aria-label={backLabel}
            title={backLabel}
            onClick={() => {
              let blocked = false;
              onNavigate?.({
                preventDefault() {
                  blocked = true;
                },
              });
              if (!blocked) back.current();
            }}
          >
            {backLabel === "Minimise canvas" ? (
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 8h5V3m9 9h-5v5M8 8 3 3m9 9 5 5" />
              </svg>
            ) : (
              children
            )}
          </button>
        );
      },
    }),
    [backLabel],
  );

  return (
    <EditorHostProvider value={host}>
      <FileEditor
        fileId={initial.id}
        fileName={initial.name}
        organizationName=""
        backHref="#"
        initialDocument={{ revision: 0, content: initial.document }}
        initialPanelsOpen={initialPanelsOpen}
        local
        statusControl={status}
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
});
