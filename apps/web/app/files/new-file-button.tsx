"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import posthog from "posthog-js";
import { createDesignFile } from "./actions";

export function NewFileButton({ folderId = null }: { folderId?: string | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setPending(true);
    setError("");
    try {
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
      <button
        type="button"
        onClick={create}
        disabled={pending}
        className="rounded-lg bg-strong-action px-4 py-2.5 text-sm font-medium text-on-strong-action hover:bg-strong-action-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange disabled:opacity-50"
      >
        {pending ? "Creating…" : "+ New file"}
      </button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
