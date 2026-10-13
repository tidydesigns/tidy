"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import posthog from "@/lib/posthog-client";
import { createDesignFile } from "./actions";
import { SelectMenu } from "@/components/ui/select-menu";
import { Icon } from "@/components/ui/icon";
import { FigmaFileImport } from "./figma-file-import";
import type { FigmaImport } from "@bella/design/figma";

export function NewFileButton({
  folderId = null,
  folderName = "Files",
  onImported,
  onCreate,
}: {
  folderId?: string | null;
  folderName?: string;
  onImported?: (result: FigmaImport) => Promise<void>;
  onCreate?: () => Promise<void>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      if (onCreate) {
        await onCreate();
        return;
      }
      const result = await createDesignFile(folderId);
      if (result.id) {
        posthog.capture("design_file_created", { in_folder: Boolean(folderId) });
        router.push(`/files/${encodeURIComponent(result.id)}`);
      } else setError(result.error ?? "Could not create the file.");
    } catch {
      setError("Could not create the file. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-stretch rounded-lg bg-strong-action text-on-strong-action">
        <button
          type="button"
          onClick={create}
          disabled={pending}
          className="rounded-l-lg px-4 py-2.5 text-sm font-medium hover:bg-strong-action-hover focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange disabled:opacity-50 active:scale-[0.98]"
        >
          {pending ? "Creating…" : "+ New file"}
        </button>
        <SelectMenu
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
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
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
