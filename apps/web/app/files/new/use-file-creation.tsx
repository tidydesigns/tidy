"use client";

import { useEffect, useRef, useState } from "react";
import { createDraftFile } from "../actions";
import { useErrorNotice } from "@/lib/use-error-notice";
import posthog from "@/lib/posthog-client";

export type FileCreation = { id: string; organizationId: string; folderId: string | null };

// Kept in the regular editor host so action revalidation cannot remount the
// canvas or discard edits when the draft becomes a durable file.
export function useFileCreation(creation?: FileCreation) {
  const [draft] = useState(() => {
    if (!creation) return null;
    let resolve!: () => void;
    const ready = new Promise<void>((done) => {
      resolve = done;
    });
    return { ...creation, ready, resolve };
  });
  const started = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [, setError] = useErrorNotice("", "file_create");
  useEffect(() => {
    if (!draft || started.current) return;
    started.current = true;
    const notify = setError("");
    void (async () => {
      try {
        const result = await createDraftFile(draft.id, draft.folderId, draft.organizationId);
        if (result.error) {
          notify(result.error);
          setFailed(true);
          return;
        }
        draft.resolve();
        // Native history keeps the live editor and queued edits mounted.
        if (mounted.current && window.location.pathname === `/files/${draft.id}`)
          window.history.replaceState(null, "", `/files/${draft.id}`);
        posthog.capture("design_file_created", { in_folder: Boolean(draft.folderId) });
      } catch (error) {
        notify(error, "Could not create the file. Your draft is still open. Retry to sync it.");
        setFailed(true);
      }
    })();
  }, [attempt, draft, setError]);
  return {
    persistenceReady: draft?.ready,
    statusControl: failed ? (
      <button
        type="button"
        onClick={() => {
          started.current = false;
          setFailed(false);
          setAttempt((value) => value + 1);
        }}
        className="rounded-lg bg-panel px-3 py-2 text-sm shadow-sm"
      >
        Retry file creation
      </button>
    ) : undefined,
  };
}
