"use client";

import { useErrorNotice } from "@/lib/use-error-notice";

import { useEffect, useRef, useState, useTransition } from "react";
import { NavigationLink } from "@/components/ui/navigation-link";
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
  initialFileId,
  folderId = null,
  folderName = "Files",
  organizationId,
  onImported,
  onCreate,
}: {
  initialFileId?: string;
  folderId?: string | null;
  folderName?: string;
  organizationId?: string;
  onImported?: (result: FigmaImport) => Promise<void>;
  onCreate?: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [draftId, setDraftId] = useState<string | null>(initialFileId ?? null);
  const query = new URLSearchParams();
  query.set("new", "1");
  if (folderId) query.set("folder", folderId);
  if (organizationId) query.set("organization", organizationId);
  const href = `/files/${draftId ?? "new"}?${query}`;
  useEffect(() => {
    if (onCreate) return;
    preloadEditor();
  }, [onCreate]);
  const creating = useRef(false);
  const [importOpen, setImportOpen] = useState(false);
  const [, setError] = useErrorNotice("", "file_create");

  function create() {
    if (!onCreate) return;
    if (creating.current) return;
    creating.current = true;
    const notifyError = setError("");
    preloadEditor();
    startTransition(async () => {
      try {
        await onCreate();
      } catch (error) {
        notifyError(error, "Could not create the file. Please try again.");
      } finally {
        creating.current = false;
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-stretch rounded-lg bg-strong-action text-on-strong-action">
        {onCreate ? (
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
        ) : (
          <NavigationLink
            href={href}
            prefetch={true}
            onNavigate={() => setDraftId(crypto.randomUUID())}
            onMouseEnter={preloadEditor}
            onFocus={preloadEditor}
            onTouchStart={preloadEditor}
            className="rounded-l-lg px-4 py-2.5 text-sm font-medium hover:bg-strong-action-hover focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange active:scale-[0.98]"
          >
            <span data-ph-public>+ New file</span>
          </NavigationLink>
        )}
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
