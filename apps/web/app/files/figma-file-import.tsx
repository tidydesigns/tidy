"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FIGMA_LIMITS } from "@bella/design/figma-input";
import type { FigmaImport, FigmaPage } from "@bella/design/figma";
import { inspectFigma, readFigma } from "@/lib/design/figma-client";
import { Dialog } from "@/components/ui/dialog";

export function FigmaFileImport({
  onImported,
  folderId = null,
}: {
  onImported?: (result: FigmaImport) => Promise<void>;
  folderId?: string | null;
}) {
  const picker = useRef<HTMLInputElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    router = useRouter();
  const busy = useRef(false),
    controller = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [choice, setChoice] = useState<{
    file: File;
    pages: FigmaPage[];
    selected: string[];
  } | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function publish(file: File, pages?: string[]) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    controller.current = new AbortController();
    const signal = controller.current.signal;
    try {
      const result = await readFigma(
        {
          bytes: new Uint8Array(await file.arrayBuffer()),
          name: file.name.replace(/\.fig$/i, ""),
          pages,
        },
        signal,
      );
      if (signal.aborted) return;
      if (onImported) {
        await onImported(result);
        return;
      }
      const assets = result.assets.map((asset) => {
        let binary = "";
        for (let i = 0; i < asset.bytes.length; i += 8192)
          binary += String.fromCharCode(...asset.bytes.subarray(i, i + 8192));
        return { id: asset.id, mimeType: asset.mimeType, base64: btoa(binary) };
      });
      const body = JSON.stringify({
        name: result.name,
        document: result.document,
        assets,
        folderId,
      });
      if (new TextEncoder().encode(body).byteLength > 16_000_000)
        throw new Error("This import exceeds 16 MB. Select fewer pages or reduce image sizes.");
      const response = await fetch("/api/figma/import", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body,
      });
      const value: { fileId?: string; error?: string } = await response.json();
      if (!response.ok || !value.fileId)
        throw new Error(value.error ?? "Could not import this Figma file.");
      router.push(`/files/${encodeURIComponent(value.fileId)}`);
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not import this Figma file.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function choose(file: File) {
    if (busy.current || choice) return;
    busy.current = true;
    setPending(true);
    setError("");
    controller.current = new AbortController();
    const signal = controller.current.signal;
    try {
      if (!file.name.toLowerCase().endsWith(".fig") || file.size > FIGMA_LIMITS.inputBytes)
        throw new Error("Choose a Figma Design .fig file under 32 MB.");
      const pages = await inspectFigma({ bytes: new Uint8Array(await file.arrayBuffer()) }, signal);
      if (signal.aborted) return;
      busy.current = false;
      if (pages.length > 1) {
        const total = pages.reduce((sum, page) => sum + page.nodeCount, 0);
        setChoice({
          file,
          pages,
          selected:
            total <= FIGMA_LIMITS.nodes
              ? pages.map((page) => page.id)
              : [pages.find((page) => page.nodeCount <= FIGMA_LIMITS.nodes)?.id ?? ""],
        });
      } else await publish(file);
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not read this Figma file.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  useEffect(() => {
    if (choice && !dialog.current?.open) dialog.current?.showModal();
  }, [choice]);
  // Drop is scoped to the mounted file-browser entry point; internal folder drags pass through.
  useEffect(() => {
    const drag = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.some((file) => file.name.toLowerCase().endsWith(".fig"))) return;
      event.preventDefault();
      event.stopPropagation();
      if (files.length !== 1) {
        setError("Import one Figma file at a time.");
        return;
      }
      void choose(files[0]);
    };
    window.addEventListener("dragover", drag);
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragover", drag);
      window.removeEventListener("drop", drop, true);
    };
  });
  const count =
    choice?.pages
      .filter((page) => choice.selected.includes(page.id))
      .reduce((sum, page) => sum + page.nodeCount, 0) ?? 0;
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => picker.current?.click()}
        className="rounded-lg border border-primary-grey/70 px-4 py-2.5 text-sm hover:bg-primary-grey/20 disabled:opacity-50"
      >
        {pending ? "Importing…" : "Import Figma"}
      </button>
      <input
        ref={picker}
        type="file"
        accept=".fig"
        aria-label="Import Figma file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void choose(file);
        }}
      />
      {error && (
        <p role="alert" className="max-w-sm text-xs text-danger">
          {error}
        </p>
      )}
      <Dialog ref={dialog} aria-label="Choose Figma pages" onClose={() => setChoice(null)}>
        {choice && (
          <>
            <p className="mb-3 text-sm">Choose pages from {choice.file.name}</p>
            <div className="max-h-[50dvh] space-y-1 overflow-y-auto">
              {choice.pages.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  role="checkbox"
                  aria-checked={choice.selected.includes(page.id)}
                  onClick={() =>
                    setChoice({
                      ...choice,
                      selected: choice.selected.includes(page.id)
                        ? choice.selected.filter((id) => id !== page.id)
                        : [...choice.selected, page.id],
                    })
                  }
                  className="flex w-full items-center justify-between rounded border border-primary-grey/70 px-3 py-2 text-left text-sm hover:bg-primary-grey/20"
                >
                  <span>
                    {choice.selected.includes(page.id) ? "✓ " : ""}
                    {page.name}
                  </span>
                  <span className="text-xs text-secondary-ink">
                    {page.nodeCount.toLocaleString()} layers
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-secondary-ink">
              {count.toLocaleString()} layers selected · up to {FIGMA_LIMITS.nodes.toLocaleString()}{" "}
              per Tidy file
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => dialog.current?.close()}
                className="rounded px-3 py-2 text-sm hover:bg-primary-grey/20"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!count || count > FIGMA_LIMITS.nodes || pending}
                onClick={() => {
                  const current = choice;
                  dialog.current?.close();
                  void publish(current.file, current.selected);
                }}
                className="rounded bg-strong-action px-3 py-2 text-sm text-on-strong-action disabled:opacity-50"
              >
                Import pages
              </button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
