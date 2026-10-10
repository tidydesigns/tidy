"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileVersion, VersionPreview } from "@/lib/design/file-versions";
import type { DesignDocument } from "@/lib/design/document";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { SelectMenu } from "@/components/ui/select-menu";
import { TextField } from "@/components/ui/text-field";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { documentFontReferences } from "@/lib/design/fonts/recovery";
import { useFontRegistry } from "@/lib/design/fonts/use-document-fonts";
import { mapConcurrent } from "@/lib/map-concurrent";
import { openFeedback } from "@/lib/feedback/commands";
const button =
  "rounded-md border border-primary-grey/70 px-2.5 py-1.5 text-xs hover:bg-primary-grey/20 disabled:opacity-40";
type List = { versions: FileVersion[]; nextCursor: string | null };
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? "Could not read file history.");
  return value;
}
const body = (value: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
function VersionFonts({ document }: { document: DesignDocument }) {
  const registry = useFontRegistry();
  const references = useMemo(() => documentFontReferences(document), [document]);
  useEffect(() => {
    let active = true;
    const release = registry.retainFamilies(
      references.map((ref) => ref.style.fontFamily ?? "system-ui"),
    );
    void mapConcurrent(references, 4, async ({ style, text }) => {
      if (active)
        await registry.load(
          style.fontFamily ?? "system-ui",
          style.fontWeight ?? 400,
          style.fontStyle === "italic",
          text,
          style.fontSource,
          style.fontFace,
        );
    });
    return () => {
      active = false;
      release();
    };
  }, [references, registry]);
  const failed = [
    ...new Set(
      references
        .filter(({ style }) =>
          ["missing", "error"].includes(
            registry.getStatus(
              style.fontFamily ?? "system-ui",
              style.fontWeight ?? 400,
              style.fontStyle === "italic",
              style.fontSource,
              style.fontFace,
            ) ?? "",
          ),
        )
        .map(({ style }) => style.fontFamily ?? "system-ui"),
    ),
  ];
  if (!failed.length) return null;
  return (
    <details className="text-xs text-secondary-ink">
      <summary>Unavailable fonts · {failed.length}</summary>
      <div className="max-h-24 overflow-auto">
        {failed.map((family) => (
          <p key={family}>{family} · Using a fallback on this device</p>
        ))}
      </div>
    </details>
  );
}
export function FileVersionControl({
  fileId,
  revision,
  canEdit,
  disabled,
  onRestore,
}: {
  fileId: string;
  revision: number;
  canEdit: boolean;
  disabled: boolean;
  onRestore: (versionId: string, expectedRevision: number) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    requests = useRef(0);
  const interactions = useRef(0);
  const [list, setList] = useState<List | null>(null),
    [open, setOpen] = useState(false),
    [versionId, setVersionId] = useState("");
  const [preview, setPreview] = useState<VersionPreview | null>(null),
    [frameId, setFrameId] = useState("");
  const [name, setName] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [imageFailed, setImageFailed] = useState(false);
  const selection = useRef(versionId);
  useLayoutEffect(() => {
    selection.current = versionId;
  }, [versionId]);
  const invalidateRequests = useCallback(() => {
    requests.current++;
  }, []);
  const base = `/api/files/${encodeURIComponent(fileId)}/history`;
  const load = useCallback(
    async (before?: string) => {
      const next = await api<List>(`${base}${before ? `?before=${before}` : ""}`);
      setList((current) =>
        before && current
          ? {
              versions: [
                ...new Map(
                  [...current.versions, ...next.versions].map((version) => [version.id, version]),
                ).values(),
              ],
              nextCursor: next.nextCursor,
            }
          : next,
      );
      setVersionId((current) => current || next.versions[0]?.id || "");
      return next;
    },
    [base],
  );
  useEffect(() => {
    let active = true;
    void api<List>(base).then(
      (next) => {
        if (active) {
          setList(next);
          setVersionId(next.versions[0]?.id ?? "");
        }
      },
      () => {},
    );
    return () => {
      active = false;
      invalidateRequests();
    };
  }, [base, invalidateRequests]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    if (!versionId || !open) return;
    const request = ++requests.current;
    void api<VersionPreview>(`${base}/${versionId}`).then(
      (next) => {
        if (request !== requests.current) return;
        setPreview(next);
        setImageFailed(false);
        setFrameId((current) =>
          next.content.nodes.some((node) => node.id === current && node.parentId === null)
            ? current
            : (next.content.nodes.find((node) => node.parentId === null && node.visible)?.id ?? ""),
        );
        setError("");
      },
      (cause) => {
        if (request === requests.current) {
          setPreview(null);
          setError(cause instanceof Error ? cause.message : "Could not read version.");
        }
      },
    );
    return () => {
      invalidateRequests();
    };
  }, [base, versionId, open, invalidateRequests]);
  async function create() {
    const submitted = name.trim(),
      selected = selection.current,
      interaction = interactions.current;
    if (!submitted) return;
    setPending(true);
    setError("");
    try {
      const result = await api<{ id: string }>(
        base,
        body({ id: crypto.randomUUID(), name: submitted, expectedRevision: revision }),
      );
      await load();
      if (interactions.current === interaction) {
        setName((current) => (current.trim() === submitted ? "" : current));
        if (selection.current === selected) setVersionId(result.id);
      }
    } catch (cause) {
      if (interactions.current === interaction)
        setError(cause instanceof Error ? cause.message : "Could not create version.");
    } finally {
      setPending(false);
    }
  }
  async function restore() {
    if (!preview || preview.version.id !== versionId) return;
    const interaction = interactions.current;
    setPending(true);
    setError("");
    try {
      await onRestore(versionId, preview.currentRevision);
      await load();
      if (interactions.current === interaction) setOpen(false);
    } catch (cause) {
      if (interactions.current === interaction)
        setError(cause instanceof Error ? cause.message : "Could not restore version.");
    } finally {
      setPending(false);
    }
  }
  const roots =
    preview?.content.nodes.filter((node) => node.parentId === null && node.visible) ?? [];
  return (
    <>
      <SelectMenu
        actionMenu
        label="File actions"
        value=""
        placement="top"
        options={[
          { value: "history", label: "Version history", icon: <Icon name="history" size={18} /> },
          { value: "feedback", label: "Send feedback", icon: <Icon name="feedback" size={18} /> },
        ]}
        triggerContent={<Icon name="more" size={18} />}
        triggerClassName="flex size-10 items-center justify-center rounded-lg border border-primary-grey/70 bg-primary-white text-secondary-ink shadow-sm hover:bg-surface hover:text-primary-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange active:scale-[0.97]"
        onChange={(action) => {
          if (action === "feedback") {
            openFeedback();
            return;
          }
          interactions.current++;
          setError("");
          setOpen(true);
          void load().catch((cause) =>
            setError(cause instanceof Error ? cause.message : "Could not read file history."),
          );
        }}
      />
      <Dialog
        ref={dialog}
        size="wide"
        aria-label="Version history"
        onKeyDown={(event) => event.stopPropagation()}
        onClose={() => {
          interactions.current++;
          setOpen(false);
          requests.current++;
        }}
        className="max-w-3xl overscroll-contain touch-auto"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Version history</p>
            <button type="button" className={button} onClick={() => setOpen(false)}>
              Close history
            </button>
          </div>
          {canEdit && (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  id={`version-name-${fileId}`}
                  label="Version name"
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <button
                type="button"
                className={button}
                disabled={disabled || pending || !name.trim()}
                onClick={() => void create()}
              >
                Create version
              </button>
            </div>
          )}
          {!list && !error && (
            <p role="status" className="text-xs text-secondary-ink">
              Loading history…
            </p>
          )}
          {!!list?.versions.length && (
            <SelectMenu
              label="Version"
              value={versionId}
              onChange={(id) => {
                if (id === versionId) return;
                interactions.current++;
                setVersionId(id);
                setPreview(null);
              }}
              options={list.versions.map((version) => ({
                value: version.id,
                label: `${version.name ?? "Automatic version"} · r${version.revision} · ${new Date(version.createdAt).toLocaleString()}`,
              }))}
            />
          )}
          {list?.nextCursor && (
            <button
              type="button"
              className={button}
              disabled={pending}
              onClick={() =>
                void load(list.nextCursor!).catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : "Could not read older versions.",
                  ),
                )
              }
            >
              Older versions
            </button>
          )}
          {preview && preview.version.id === versionId && (
            <>
              <p className="text-xs text-secondary-ink">
                {preview.version.author ?? "Automatic checkpoint"} · Preview r
                {preview.version.revision} · Current r{preview.currentRevision}
              </p>
              {roots.length > 1 && (
                <SelectMenu
                  label="Version frame"
                  value={frameId}
                  onChange={(id) => {
                    interactions.current++;
                    setFrameId(id);
                  }}
                  options={roots.map((root) => ({ value: root.id, label: root.name }))}
                />
              )}
              <div
                className="max-h-[50dvh] overflow-auto overscroll-contain"
                aria-label="Version preview"
                onErrorCapture={() => setImageFailed(true)}
              >
                <DesignSnapshot
                  reviewId=""
                  content={preview.content}
                  frameId={frameId}
                  selectedNode={null}
                  onSelect={() => {}}
                  assetUrl={(id) => `${base}/${versionId}/assets/${encodeURIComponent(id)}`}
                />
              </div>
              <VersionFonts document={preview.content} />
              {imageFailed && (
                <p role="alert" className="text-xs text-danger">
                  One or more images in this version could not be loaded.
                </p>
              )}
              {canEdit && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className={button}
                    disabled={disabled || pending}
                    onClick={() => void restore()}
                  >
                    Restore version
                  </button>
                  <p className="text-xs text-secondary-ink">
                    The current file will be recorded before restore.
                  </p>
                </div>
              )}
            </>
          )}
          {pending && (
            <p role="status" className="text-xs">
              Updating history…
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
