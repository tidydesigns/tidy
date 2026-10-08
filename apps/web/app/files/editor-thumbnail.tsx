"use client";
import { memo, startTransition, useEffect, useRef, useState } from "react";
import { thumbnailIsCurrent } from "@/lib/design/thumbnail-version";
import { FileThumbnail } from "./file-thumbnail";
import type { Snapshot } from "./thumbnail-renderer";
import { cachedThumbnail } from "./thumbnail-cache";

type DocumentSnapshot = NonNullable<Snapshot["document"]>;
type Prepared = { version: string; thumbnailVersion: string | null; snapshot: Snapshot };

/** Prepare a committed revision while the editor is idle, using its existing
 * document. Pointer/keyboard/wheel activity cancels the extra scene immediately. */
export const EditorThumbnail = memo(function EditorThumbnail({
  fileId,
  revision,
  enabled,
  cacheScope,
  getSnapshot,
}: {
  fileId: string;
  revision: number;
  enabled: boolean;
  cacheScope?: string;
  getSnapshot: () => DocumentSnapshot;
}) {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const completed = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prepare = async () => {
      const cached = cachedThumbnail(cacheScope, fileId);
      if (
        completed.current === revision ||
        (cached?.persisted && Number(cached.version.split(":", 1)[0]) === revision)
      )
        return;
      const requestController = new AbortController();
      controller = requestController;
      try {
        const response = await fetch("/api/files/versions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [fileId] }),
          signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(10_000)]),
          cache: "no-store",
        });
        if (!response.ok) return;
        const result = (await response.json()) as {
          versions: Record<string, string>;
          thumbnailVersions: Record<string, string | null>;
        };
        if (requestController.signal.aborted) return;
        const version = result.versions[fileId];
        if (!version || Number(version.split(":", 1)[0]) !== revision) return;
        if (thumbnailIsCurrent(result.thumbnailVersions[fileId], version)) {
          completed.current = revision;
          return;
        }
        const document = getSnapshot();
        if (document.revision !== revision) return;
        startTransition(() =>
          setPrepared({
            version,
            thumbnailVersion: result.thumbnailVersions[fileId] ?? null,
            snapshot: { document, frames: [], rectangles: [] },
          }),
        );
      } catch {
        /* The list's bounded fallback remains available. */
      }
    };
    const idle = () => {
      controller?.abort();
      clearTimeout(timer);
      setPrepared(null);
      if (!document.hidden) timer = setTimeout(() => void prepare(), 1500);
    };
    idle();
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const event of events) window.addEventListener(event, idle, { passive: true });
    document.addEventListener("visibilitychange", idle);
    return () => {
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", idle);
      for (const event of events) window.removeEventListener(event, idle);
    };
  }, [enabled, fileId, revision, getSnapshot, cacheScope]);
  if (!enabled || !prepared || Number(prepared.version.split(":", 1)[0]) !== revision) return null;
  return (
    <div
      data-editor-thumbnail
      aria-hidden="true"
      className="pointer-events-none fixed -left-[1024px] top-0 h-80 w-[512px] opacity-0"
    >
      <FileThumbnail
        key={prepared.version}
        fileId={fileId}
        initialVersion={prepared.version}
        thumbnailVersion={prepared.thumbnailVersion}
        snapshot={prepared.snapshot}
        cacheScope={cacheScope}
        canGenerate
        prewarm
      />
    </div>
  );
});
