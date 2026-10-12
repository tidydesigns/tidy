"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileEditor } from "@/app/files/[uid]/file-editor";
import { FigmaFileImport } from "@/app/files/figma-file-import";
import { parseDesignDocument, type DesignDocument } from "@bella/design/document";
import type { FigmaImport } from "@bella/design/figma";
import { readLocalDraft, writeLocalDraft, type LocalDraft } from "./draft";

export function FigmaImportPreview() {
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
  }
  if (!ready) return <div className="p-6 text-sm text-secondary-ink">Opening local draft…</div>;
  const empty = parseDesignDocument({
    schemaVersion: 1,
    legacyConverted: true,
    nodes: [],
    tokens: {},
    warnings: [],
  });
  return (
    <>
      <div className="fixed left-80 top-3 z-50 flex items-center gap-3">
        <FigmaFileImport onImported={imported} />
        <span className="text-xs text-secondary-ink">
          Local prototype · retained in this browser
        </span>
        {error && (
          <p role="alert" className="max-w-xs text-xs text-danger">
            {error}
          </p>
        )}
      </div>
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
