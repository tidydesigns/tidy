"use client";
import { useEffect, useRef, useState } from "react";
import { FileEditor } from "@/app/files/[uid]/file-editor";
import { FigmaFileImport } from "@/app/files/figma-file-import";
import { parseDesignDocument, type DesignDocument } from "@bella/design/document";
import type { FigmaImport } from "@bella/design/figma";

export function FigmaImportPreview() {
  const [document, setDocument] = useState<DesignDocument>(() =>
    parseDesignDocument({
      schemaVersion: 1,
      legacyConverted: true,
      nodes: [],
      tokens: {},
      warnings: [],
    }),
  );
  const [assets, setAssets] = useState<Record<string, string>>({}),
    [version, setVersion] = useState(0);
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), []);
  async function imported(result: FigmaImport) {
    window.dispatchEvent(new CustomEvent("tidy:figma-imported", { detail: result.document }));
    const next: Record<string, string> = {};
    for (const asset of result.assets) {
      const url = URL.createObjectURL(
        new Blob([asset.bytes.slice().buffer as ArrayBuffer], { type: asset.mimeType }),
      );
      urls.current.push(url);
      next[asset.id] = url;
    }
    setAssets(next);
    setDocument(result.document);
    setVersion((v) => v + 1);
  }
  return (
    <>
      <div className="fixed left-80 top-3 z-50">
        <FigmaFileImport onImported={imported} />
      </div>
      <FileEditor
        key={version}
        fileId={`figma-preview-${version}`}
        fileName="Figma import preview"
        organizationName="Local fixture"
        backHref="/login"
        initialDocument={{ revision: 1, content: document }}
        canEdit
        preview={false}
        local
        initialPanelsOpen
        previewAssetUrls={assets}
      />
    </>
  );
}
