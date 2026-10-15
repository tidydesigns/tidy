"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FIGMA_LIMITS } from "@bella/design/figma-input";
import type { FigmaImport, FigmaPage } from "@bella/design/figma";
import { inspectFigma, readFigma } from "@/lib/design/figma-client";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";

export function FigmaFileImport({
  onImported,
  folderId = null,
  folderName = "Files",
  disabled = false,
  open,
  onOpenChange,
}: {
  onImported?: (result: FigmaImport) => Promise<void>;
  folderId?: string | null;
  folderName?: string;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const picker = useRef<HTMLInputElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    chooseButton = useRef<HTMLButtonElement>(null),
    router = useRouter();
  const busy = useRef(false),
    controller = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState(""),
    [error, setError] = useState("");
  const pending = Boolean(phase);
  const committing = phase === "Creating file…" || phase === "Opening file…";
  const [dragging, setDragging] = useState(false);
  const [choice, setChoice] = useState<{
    file: File;
    pages: FigmaPage[];
    selected: string[];
  } | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function publish(file: File, pages?: string[]) {
    if (busy.current) return;
    busy.current = true;
    setPhase("Importing pages…");
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
        setPhase("Opening file…");
        await onImported(result);
        onOpenChange(false);
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
      setPhase("Creating file…");
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
      onOpenChange(false);
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not import this Figma file.");
    } finally {
      busy.current = false;
      setPhase("");
    }
  }
  async function choose(file: File) {
    if (busy.current) return;
    busy.current = true;
    setPhase("Reading file…");
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
              : [pages.find((page) => page.nodeCount <= FIGMA_LIMITS.nodes)?.id ?? ""].filter(
                  Boolean,
                ),
        });
      } else setChoice({ file, pages, selected: pages.map((page) => page.id) });
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not read this Figma file.");
    } finally {
      busy.current = false;
      setPhase("");
    }
  }
  useEffect(() => {
    if (open && !dialog.current?.open) {
      dialog.current?.showModal();
      chooseButton.current?.focus({ preventScroll: true });
    } else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    if (choice?.file && dialog.current?.open)
      dialog.current
        .querySelector<HTMLButtonElement>('[role="checkbox"]')
        ?.focus({ preventScroll: true });
  }, [choice?.file]);
  function dismiss() {
    if (committing) return;
    controller.current?.abort();
    dialog.current?.close();
  }
  // File drops belong to the Files screen; this component is never mounted on
  // the canvas. Folder drags do not contain Files and pass through.
  useEffect(() => {
    const drag = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.some((file) => file.name.toLowerCase().endsWith(".fig"))) return;
      event.preventDefault();
      event.stopPropagation();
      if (busy.current || disabled) return;
      onOpenChange(true);
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
    <Dialog
      ref={dialog}
      size="lg"
      padded={false}
      aria-label="Import from Figma"
      onCancel={(event) => {
        if (committing) event.preventDefault();
        else controller.current?.abort();
      }}
      onClose={() => {
        controller.current?.abort();
        setChoice(null);
        setError("");
        setDragging(false);
        onOpenChange(false);
      }}
    >
      <div className="flex items-start justify-between gap-4 px-6 pt-6">
        <div>
          <h2 data-ph-public className="text-lg font-semibold tracking-tight">
            Import from Figma
          </h2>
          <p className="mt-1 text-sm text-secondary-ink">
            <span data-ph-public style={{ display: "contents" }}>
              Create an editable file in{" "}
            </span>
            {folderName}
            <span data-ph-public style={{ display: "contents" }}>
              .
            </span>
          </p>
        </div>
        <button
          data-ph-public-label
          type="button"
          aria-label="Close import"
          disabled={committing}
          onClick={dismiss}
          className="rounded-md p-1.5 text-secondary-ink hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-40 active:scale-[0.97]"
        >
          <Icon name="xmark" size={18} />
        </button>
      </div>
      <input
        data-ph-public-label
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
      <div className="min-h-60 px-6 py-5">
        {choice ? (
          <>
            <div className="mb-4 flex min-w-0 items-center gap-3">
              <Icon name="frame" size={20} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={choice.file.name}>
                  {choice.file.name}
                </p>
                <p className="text-xs text-secondary-ink">
                  {(choice.file.size / 1048576).toFixed(1)}{" "}
                  <span data-ph-public style={{ display: "contents" }}>
                    MB
                  </span>
                </p>
              </div>
              <button
                data-ph-public
                type="button"
                disabled={pending}
                onClick={() => picker.current?.click()}
                className="shrink-0 rounded-md px-2 py-1.5 text-xs text-secondary-ink hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-40"
              >
                Change file
              </button>
            </div>
            <div className="max-h-[min(40dvh,20rem)] overflow-y-auto overscroll-contain rounded-lg border border-primary-grey/70 p-1">
              {choice.pages.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  role="checkbox"
                  aria-checked={choice.selected.includes(page.id)}
                  disabled={pending}
                  onClick={() =>
                    setChoice({
                      ...choice,
                      selected: choice.selected.includes(page.id)
                        ? choice.selected.filter((id) => id !== page.id)
                        : [...choice.selected, page.id],
                    })
                  }
                  className="flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-primary-grey/15 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-60"
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${choice.selected.includes(page.id) ? "border-strong-action bg-strong-action text-on-strong-action" : "border-primary-grey bg-surface"}`}
                  >
                    {choice.selected.includes(page.id) && <Icon name="check" size={12} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={page.name}>
                    {page.name}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-secondary-ink">
                    {page.nodeCount.toLocaleString()}{" "}
                    <span data-ph-public style={{ display: "contents" }}>
                      layers
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <p
              className={`mt-3 text-xs tabular-nums ${count > FIGMA_LIMITS.nodes ? "text-danger" : "text-secondary-ink"}`}
            >
              {count.toLocaleString()}{" "}
              <span data-ph-public style={{ display: "contents" }}>
                layers selected
              </span>
              <span data-ph-public style={{ display: "contents" }}>
                {count > FIGMA_LIMITS.nodes ? " · choose fewer pages" : ""}
              </span>
            </p>
          </>
        ) : (
          <button
            type="button"
            ref={chooseButton}
            disabled={pending}
            onClick={() => picker.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={() => setDragging(false)}
            className={`flex min-h-48 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-8 text-sm focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-60 ${dragging ? "border-primary-orange bg-primary-grey/15" : "border-primary-grey bg-surface/30 hover:bg-primary-grey/10"}`}
          >
            <Icon name="frame" size={28} />
            <span data-ph-public className="font-medium">
              Choose a Figma file
            </span>
            <span data-ph-public className="text-xs text-secondary-ink">
              Or drop a .fig file here · up to 32 MB
            </span>
          </button>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="flex min-h-18 flex-wrap items-center justify-between gap-3 border-t border-primary-grey/60 px-6 py-4">
        <p role="status" aria-live="polite" className="text-xs text-secondary-ink">
          {phase ||
            (choice
              ? `${choice.selected.length} ${choice.selected.length === 1 ? "page" : "pages"} selected`
              : "In Figma: File → Save local copy.")}
        </p>
        <div className="flex items-center gap-2">
          <button
            data-ph-public
            type="button"
            disabled={committing}
            onClick={dismiss}
            className="rounded-lg px-3 py-2 text-sm hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-40 active:scale-[0.97]"
          >
            Cancel
          </button>
          {choice && (
            <button
              data-ph-public
              type="button"
              disabled={!count || count > FIGMA_LIMITS.nodes || pending}
              onClick={() => void publish(choice.file, choice.selected)}
              className="rounded-lg bg-strong-action px-4 py-2 text-sm font-medium text-on-strong-action hover:bg-strong-action-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange disabled:opacity-50 active:scale-[0.97]"
            >
              Import pages
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
