import { useCallback, useRef, useState } from "react";
import { showToast } from "@tidy/ui/toast";
import type { DesktopAPI, Thread, ThreadSummary } from "../../../../shared/contracts/desktop";
import { currentThreadNaming } from "../settings/thread-naming-preferences";

/** A late completion must never remove the user's next optimistic rename. */
export function useThreadNames(api: DesktopAPI | undefined, receive: (thread: Thread) => void) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState<Record<string, boolean>>({});
  const versions = useRef(new Map<string, number>());
  const rename = useCallback(
    (thread: ThreadSummary, title: string) => {
      if (!api) return;
      const version = (versions.current.get(thread.id) ?? 0) + 1;
      versions.current.set(thread.id, version);
      setOverrides((current) => ({ ...current, [thread.id]: title }));
      void api
        .renameThread(thread.projectId, thread.id, title)
        .then(receive)
        .catch((error: unknown) => {
          if (versions.current.get(thread.id) === version)
            showToast(
              error instanceof Error ? error.message : "Could not rename the thread.",
              "error",
            );
        })
        .finally(() => {
          if (versions.current.get(thread.id) !== version) return;
          setOverrides((current) => {
            const next = { ...current };
            delete next[thread.id];
            return next;
          });
        });
    },
    [api, receive],
  );
  const regenerate = useCallback(
    (thread: ThreadSummary) => {
      if (!api) return;
      const version = versions.current.get(thread.id) ?? 0;
      setGenerating((current) => ({ ...current, [thread.id]: true }));
      void api
        .regenerateThreadTitle(thread.projectId, thread.id, currentThreadNaming())
        .then(receive)
        .catch((error: unknown) => {
          if ((versions.current.get(thread.id) ?? 0) === version)
            showToast(
              error instanceof Error
                ? error.message
                : "Could not generate a name. The current name was kept.",
              "error",
            );
        })
        .finally(() => setGenerating((current) => ({ ...current, [thread.id]: false })));
    },
    [api, receive],
  );
  return { overrides, generating, rename, regenerate };
}
