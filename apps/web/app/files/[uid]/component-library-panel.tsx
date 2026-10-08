"use client";
import { z } from "zod";
import { useState } from "react";
import { parseDesignDocument, type DesignDocument, type DesignNode } from "@/lib/design/document";
import { createComponentInstance } from "@/lib/design/document-operations";
import {
  libraryPayload,
  importLibraryComponent,
  markLibraryStatus,
} from "@/lib/design/component-libraries";
import {
  clipboardAssetIds,
  remapClipboardAssets,
  type DesignClipboard,
} from "@/lib/design/clipboard";
import { SelectMenu } from "@/components/ui/select-menu";
import { PropertyField } from "./property-field";
const button =
  "shrink-0 rounded border border-primary-grey/70 px-2 py-1 text-xs hover:bg-primary-grey/15 disabled:opacity-40";
type Source = { fileUid: string; name: string; revision: number; content: DesignDocument };
async function loadSource(fileUid: string): Promise<Source> {
  const url = new URL(fileUid, window.location.href);
  const candidate = url.pathname.split("/").filter(Boolean).at(-1) ?? fileUid;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate))
    throw new Error("Enter a file URL or file ID.");
  const response = await fetch(`/api/files/${encodeURIComponent(candidate)}/snapshot`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Source file is unavailable or access was removed.");
  const source = z
    .object({
      name: z.string(),
      document: z.object({ revision: z.number().int().min(0), content: z.unknown() }).nullable(),
    })
    .parse(await response.json());
  if (!source.document) throw new Error("Source file has no editable document.");
  return {
    fileUid: candidate,
    name: source.name,
    revision: source.document.revision,
    content: parseDesignDocument(source.document.content),
  };
}
export function ComponentLibraryPanel({
  document,
  fileId,
  local,
  onDocument,
}: {
  document: DesignDocument;
  fileId: string;
  local: boolean;
  onDocument: (update: (doc: DesignDocument) => DesignDocument) => Promise<void>;
}) {
  const components = document.nodes.filter((n) => n.isComponent);
  const [source, setSource] = useState<Source | null>(null),
    [input, setInput] = useState(""),
    [selected, setSelected] = useState(""),
    [replaceId, setReplaceId] = useState<string | undefined>(),
    [expanded, setExpanded] = useState(false),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  async function transfer(payload: DesignClipboard) {
    const ids = clipboardAssetIds(payload);
    if (local || payload.sourceFile === fileId || !ids.length) return payload;
    const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/clipboard-assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceFile: payload.sourceFile, assetIds: ids }),
    });
    const result = z
      .object({ assets: z.record(z.string(), z.string()).optional(), error: z.string().optional() })
      .parse(await response.json());
    if (!response.ok || !result.assets)
      throw new Error(result.error ?? "Library images could not be copied.");
    return remapClipboardAssets(payload, result.assets);
  }
  async function lookup() {
    setBusy("lookup");
    setError("");
    try {
      const loaded = await loadSource(input);
      if (loaded.fileUid === fileId) throw new Error("Choose a different source file.");
      setSource(loaded);
      setSelected(loaded.content.nodes.find((n) => n.isComponent && !n.librarySource)?.id ?? "");
    } catch (cause) {
      setSource(null);
      setError(cause instanceof Error ? cause.message : "Source unavailable.");
    } finally {
      setBusy(null);
    }
  }
  async function link() {
    if (!source || !selected) return;
    setBusy("link");
    setError("");
    try {
      const payload = await transfer(libraryPayload(source.content, selected, source.fileUid));
      await onDocument(
        (doc) =>
          importLibraryComponent(
            doc,
            payload,
            source.revision,
            () => crypto.randomUUID(),
            replaceId,
          ).document,
      );
      setReplaceId(undefined);
      setExpanded(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Library could not be linked.");
    } finally {
      setBusy(null);
    }
  }
  async function check(component: DesignNode, apply: boolean) {
    const identity = component.librarySource!;
    setBusy(component.id);
    setError("");
    try {
      const loaded = await loadSource(identity.fileUid);
      if (!loaded.content.nodes.some((n) => n.id === identity.componentId && n.isComponent))
        throw new Error("Library component was removed.");
      if (apply) {
        const payload = await transfer(
          libraryPayload(loaded.content, identity.componentId, loaded.fileUid),
        );
        await onDocument((doc) => {
          const current = doc.nodes.find((n) => n.id === component.id);
          if (
            current?.librarySource?.fileUid !== identity.fileUid ||
            current.librarySource.componentId !== identity.componentId
          )
            return doc;
          return importLibraryComponent(
            doc,
            payload,
            loaded.revision,
            () => crypto.randomUUID(),
            component.id,
          ).document;
        });
      } else
        await onDocument((doc) =>
          markLibraryStatus(
            doc,
            component.id,
            loaded.revision >
              (doc.nodes.find((n) => n.id === component.id)?.librarySource?.revision ??
                identity.revision)
              ? "update-available"
              : "current",
            loaded.revision,
            identity,
          ),
        );
    } catch (cause) {
      await onDocument((doc) =>
        markLibraryStatus(doc, component.id, "unavailable", undefined, identity),
      );
      setError(cause instanceof Error ? cause.message : "Source unavailable.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <details className="border-t border-primary-grey/70 text-xs text-secondary-ink">
      <summary className="cursor-pointer px-3 py-3 font-medium hover:bg-primary-grey/15 focus-visible:outline-2 focus-visible:outline-primary-orange">
        Components · {components.length}
      </summary>
      <div className="max-h-72 space-y-3 overflow-y-auto px-3 pb-3 text-primary-black">
        {components.map((component) => (
          <div key={component.id} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate" title={component.name}>
                {component.name}
              </span>
              <button
                className={button}
                aria-label={`Create instance of ${component.name}`}
                onClick={() =>
                  void onDocument(
                    (doc) =>
                      createComponentInstance(doc, component.id, () => crypto.randomUUID())
                        .document,
                  )
                }
              >
                + Instance
              </button>
            </div>
            {component.librarySource && (
              <>
                <p className="text-[10px] text-secondary-ink">
                  Revision {component.librarySource.revision} ·{" "}
                  {component.librarySource.status === "unavailable"
                    ? "Source unavailable; using cached component"
                    : component.librarySource.status === "update-available"
                      ? `Revision ${component.librarySource.availableRevision} available`
                      : "Linked source"}
                </p>
                <div className="flex flex-wrap gap-1">
                  <button
                    className={button}
                    disabled={busy === component.id}
                    onClick={() => void check(component, false)}
                  >
                    Check updates
                  </button>
                  {component.librarySource.status === "update-available" && (
                    <button
                      className={button}
                      disabled={busy === component.id}
                      onClick={() => void check(component, true)}
                    >
                      Apply update
                    </button>
                  )}
                  <button
                    className={button}
                    onClick={() => {
                      setReplaceId(component.id);
                      setSource(null);
                      setInput("");
                      setExpanded(true);
                    }}
                  >
                    Replace source
                  </button>
                  <button
                    className={button}
                    onClick={() =>
                      void onDocument((doc) => ({
                        ...doc,
                        nodes: doc.nodes.map((n) =>
                          n.id === component.id
                            ? { ...n, librarySource: undefined, locked: false }
                            : n,
                        ),
                      }))
                    }
                  >
                    Make local
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        <button
          className={button}
          onClick={() => {
            setReplaceId(undefined);
            setExpanded(!expanded);
          }}
        >
          Link library
        </button>
        {expanded && (
          <div className="space-y-2">
            <PropertyField
              label="Source file URL or ID"
              value={input}
              onCommit={(value) => {
                setInput(value);
                setSource(null);
                setSelected("");
              }}
            />
            <button
              className={button}
              disabled={busy === "lookup" || !input}
              onClick={() => void lookup()}
            >
              Find components
            </button>
            {source && (
              <>
                <SelectMenu
                  label="Library component"
                  value={selected}
                  options={source.content.nodes
                    .filter((n) => n.isComponent && !n.librarySource)
                    .map((n) => ({ value: n.id, label: n.name }))}
                  onChange={setSelected}
                />
                <button
                  className={button}
                  disabled={busy === "link" || !selected}
                  onClick={() => void link()}
                >
                  {replaceId ? "Replace component" : "Link component"}
                </button>
              </>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
