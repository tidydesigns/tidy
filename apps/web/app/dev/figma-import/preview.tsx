"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileEditor } from "@/app/files/[uid]/file-editor";
import { NewFileButton } from "@/app/files/new-file-button";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { parseDesignDocument, type DesignDocument } from "@bella/design/document";
import type { FigmaImport } from "@bella/design/figma";
import { readLocalDraft, writeLocalDraft, type LocalDraft } from "./draft";

export function FigmaImportPreview({ editor = false }: { editor?: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState<LocalDraft | null>(null);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const urls = useRef<string[]>([]);
  useEffect(() => {
    let mounted = true;
    void readLocalDraft()
      .then((restored) => {
        if (!mounted) return;
        if (restored) {
          const next: Record<string, string> = {};
          for (const [id, blob] of restored.assets) {
            const url = URL.createObjectURL(blob);
            urls.current.push(url);
            next[id] = url;
          }
          setAssets(next);
          setDraft(restored.draft);
        } else {
          setDraft({
            id: crypto.randomUUID(),
            name: "Figma import prototype",
            document: parseDesignDocument({
              schemaVersion: 1,
              legacyConverted: true,
              nodes: [],
              tokens: {},
              warnings: [],
            }),
          });
        }
      })
      .catch(() => {
        if (mounted)
          setError("Local storage is unavailable. Keep this tab open to retain your work.");
      })
      .finally(() => {
        if (mounted) setReady(true);
      });
    return () => {
      mounted = false;
      urls.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);
  const changed = useCallback(
    (document: DesignDocument, assets: Record<string, string>) => {
      if (!draft) return;
      void writeLocalDraft({ ...draft, document }, assets).catch(() =>
        setError(
          "Could not retain this draft locally. Keep this tab open and free browser storage.",
        ),
      );
    },
    [draft],
  );
  async function imported(result: FigmaImport) {
    const next: Record<string, string> = {};
    const created: string[] = [];
    for (const asset of result.assets) {
      const url = URL.createObjectURL(
        new Blob([asset.bytes.slice().buffer as ArrayBuffer], { type: asset.mimeType }),
      );
      created.push(url);
      next[asset.id] = url;
    }
    const value = { id: crypto.randomUUID(), name: result.name, document: result.document };
    try {
      await writeLocalDraft(value, next);
    } catch (cause) {
      created.forEach((url) => URL.revokeObjectURL(url));
      throw cause;
    }
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = created;
    setError("");
    setAssets(next);
    setDraft(value);
    window.dispatchEvent(new CustomEvent("tidy:figma-imported", { detail: result.document }));
    router.push("/dev/figma-import?editor=1");
  }
  if (!ready) return <div className="p-6 text-sm text-secondary-ink">Opening local draft…</div>;
  const empty = parseDesignDocument({
    schemaVersion: 1,
    legacyConverted: true,
    nodes: [],
    tokens: {},
    warnings: [],
  });
  async function createBlank() {
    const value = { id: crypto.randomUUID(), name: "Untitled", document: empty };
    await writeLocalDraft(value, {});
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = [];
    setAssets({});
    setDraft(value);
    setError("");
    router.push("/dev/figma-import?editor=1");
  }
  if (!editor)
    return (
      <main className="mx-auto max-w-5xl px-6 py-10 sm:px-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Files</h1>
            <p className="mt-1 text-xs text-secondary-ink">
              Local prototype · kept in this browser
            </p>
          </div>
          <NewFileButton onImported={imported} onCreate={createBlank} />
        </div>
        {error && (
          <p role="alert" className="mb-4 text-sm text-danger">
            {error}
          </p>
        )}
        {draft && (draft.document.nodes.length > 0 || draft.name !== "Figma import prototype") && (
          <button
            type="button"
            onClick={() => router.push("/dev/figma-import?editor=1")}
            className="flex w-full items-center gap-4 rounded-xl border border-primary-grey/60 bg-surface px-5 py-4 text-left hover:border-primary-grey hover:bg-primary-grey/10 focus-visible:outline-2 focus-visible:outline-primary-orange"
          >
            <span className="rounded-lg bg-primary-grey/15 p-3">
              <Icon name="frame" size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{draft.name}</span>
              <span className="mt-1 block text-xs text-secondary-ink">
                {draft.document.pages?.length ?? 1} pages ·{" "}
                {draft.document.nodes.length.toLocaleString()} layers
              </span>
            </span>
            <Icon name="arrowRight" size={18} />
          </button>
        )}
      </main>
    );
  return (
    <>
      {error && (
        <p
          role="alert"
          className="fixed bottom-6 left-1/2 z-50 max-w-sm -translate-x-1/2 rounded-lg border border-primary-grey bg-surface p-3 text-xs text-danger"
        >
          {error}
        </p>
      )}
      <FileEditor
        key={draft?.id ?? "empty"}
        fileId={draft?.id ?? "figma-empty"}
        fileName={draft?.name ?? "Figma import prototype"}
        organizationName="Local prototype"
        backHref="/dev/figma-import"
        initialDocument={{ revision: 1, content: draft?.document ?? empty }}
        canEdit
        local
        initialPanelsOpen
        previewAssetUrls={assets}
        onLocalDocumentChange={changed}
      />
    </>
  );
}
