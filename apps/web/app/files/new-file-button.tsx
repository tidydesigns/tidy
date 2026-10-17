"use client";

import { useRef, useState, useTransition } from "react";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { Dialog } from "@/components/ui/dialog";
import { EditorSkeleton } from "@/components/files/editor-skeleton";
import posthog from "@/lib/posthog-client";
import { createDesignFile } from "./actions";
import { SelectMenu } from "@/components/ui/select-menu";
import { Icon } from "@/components/ui/icon";
import { FigmaFileImport } from "./figma-file-import";
import type { FigmaImport } from "@tidy/design/figma";

let editorCode: Promise<unknown> | undefined;
function preloadEditor() {
  // Warm code on intent without creating a file or querying a nonexistent ID.
  editorCode ??= import("./[uid]/file-editor").catch(() => {
    editorCode = undefined;
  });
}

export function NewFileButton({
  folderId = null,
  folderName = "Files",
  organizationId,
  onImported,
  onCreate,
}: {
  folderId?: string | null;
  folderName?: string;
  organizationId?: string;
  onImported?: (result: FigmaImport) => Promise<void>;
  onCreate?: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const creating = useRef(false);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState("");

  function create() {
    if (creating.current) return;
    creating.current = true;
    setError("");
    preloadEditor();
    startTransition(async () => {
      try {
        if (onCreate) {
          await onCreate();
          return;
        }
        const result = await createDesignFile(folderId, organizationId);
        setError(result.error);
      } catch (error) {
        if (isRedirectError(error)) {
          // Next delivers successful action redirects as control-flow errors.
          // Preserve navigation and count only committed file creations.
          try {
            posthog.capture("design_file_created", { in_folder: Boolean(folderId) });
          } finally {
            throw error;
          }
        }
        setError("Could not create the file. Please try again.");
      } finally {
        creating.current = false;
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-stretch rounded-lg bg-strong-action text-on-strong-action">
        <button
          type="button"
          onClick={create}
          onPointerEnter={preloadEditor}
          onFocus={preloadEditor}
          onTouchStart={preloadEditor}
          disabled={pending}
          className="rounded-l-lg px-4 py-2.5 text-sm font-medium hover:bg-strong-action-hover focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange disabled:opacity-50 active:scale-[0.98]"
        >
          <span data-ph-public>+ New file</span>
        </button>
        <SelectMenu
          replayOptions
          replayLabel
          value=""
          actionMenu
          label="New file options"
          disabled={pending}
          placement="bottom"
          options={[
            { value: "figma", label: "Import from Figma…", icon: <Icon name="frame" size={16} /> },
          ]}
          onChange={() => setImportOpen(true)}
          triggerClassName="flex h-full items-center justify-center rounded-r-lg border-l border-white/20 px-2.5 hover:bg-strong-action-hover focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange disabled:opacity-50 active:scale-[0.98]"
          triggerContent={
            <svg
              data-ph-public
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
            >
              <path
                d="m4 6 4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
        />
      </div>
      {pending && (
        <Dialog
          ref={(dialog) => {
            if (dialog && !dialog.open) dialog.showModal();
          }}
          padded={false}
          aria-label="Creating file"
          onCancel={(event) => event.preventDefault()}
          style={{
            width: "100%",
            height: "100dvh",
            maxWidth: "none",
            maxHeight: "none",
            border: 0,
            borderRadius: 0,
          }}
        >
          <EditorSkeleton />
        </Dialog>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <FigmaFileImport
        disabled={pending}
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={onImported}
        folderId={folderId}
        folderName={folderName}
      />
    </div>
  );
}
