import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@tidy/editor/components/ui/icon";
import { ThumbnailRenderer } from "./preview-renderers";
import { queueThumbnail } from "@tidy/editor/lib/thumbnail-queue";
import type { DesktopAPI, DesignSummary, LocalDesign } from "../../../../shared/contracts/desktop";
import {
  cacheLocalThumbnail,
  cachedLocalThumbnail,
  readLocalThumbnail,
} from "./local-thumbnail-cache";

type Prepared = {
  design: LocalDesign;
  signal: AbortSignal;
  complete(blob: Blob, imagesComplete: boolean): void;
  fail(error: unknown): void;
};

/** A card retains one raster, never a mounted copy of its design scene. Only
 * one missing preview prepares at a time, and input cancels its temporary scene. */
export function LocalPreview({
  api,
  projectId,
  file,
  enabled = true,
}: {
  api: DesktopAPI;
  projectId: string;
  file: DesignSummary;
  enabled?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [blob, setBlob] = useState(() => cachedLocalThumbnail(projectId, file.id)?.blob);
  const [url, setURL] = useState<string>();
  const [prepared, setPrepared] = useState<Prepared>();
  useLayoutEffect(() => {
    if (!visible || !enabled) {
      setBlob(undefined);
      setURL(undefined);
      return;
    }
    const source = blob ?? cachedLocalThumbnail(projectId, file.id)?.blob;
    if (!source) return;
    const url = URL.createObjectURL(source);
    setURL(url);
    return () => URL.revokeObjectURL(url);
  }, [blob, visible, enabled, projectId, file.id]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: "160px",
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !enabled) return;
    const version = `png-v1:2:${file.updatedAt}`;
    let disposed = false;
    let finished = false;
    let retryOnFocus = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const prepare = async () => {
      if (disposed || finished || document.hidden) return;
      const request = new AbortController();
      controller = request;
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await queueThumbnail(async () => {
          if (document.hidden) return;
          // Waiting for another card must not consume this capture's deadline.
          timeout = setTimeout(() => {
            timedOut = true;
            request.abort();
          }, 15_000);
          const design = await api.previewDesign(projectId, file.id);
          request.signal.throwIfAborted();
          if (document.hidden) return;
          const result = await new Promise<{ blob: Blob; imagesComplete: boolean }>(
            (resolve, reject) => {
              request.signal.addEventListener("abort", () => reject(request.signal.reason), {
                once: true,
              });
              setPrepared({
                design,
                signal: request.signal,
                complete: (blob, imagesComplete) => resolve({ blob, imagesComplete }),
                fail: reject,
              });
            },
          );
          request.signal.throwIfAborted();
          finished = true;
          retryOnFocus = !result.imagesComplete;
          setBlob(result.blob);
          setPrepared(undefined);
          if (result.imagesComplete)
            void cacheLocalThumbnail(projectId, file.id, version, result.blob);
        }, request.signal);
      } catch {
        if (!disposed && controller === request) {
          if (!request.signal.aborted || timedOut) {
            finished = true;
            retryOnFocus = true;
          }
          setPrepared(undefined);
        }
      } finally {
        clearTimeout(timeout);
      }
    };
    const idle = () => {
      controller?.abort();
      clearTimeout(timer);
      setPrepared(undefined);
      if (!disposed && !finished) timer = setTimeout(() => void prepare(), 200);
    };
    const retry = () => {
      if (!retryOnFocus || document.hidden) return;
      finished = false;
      retryOnFocus = false;
      idle();
    };
    const visibility = () => {
      if (document.hidden) idle();
      else if (retryOnFocus) retry();
      else if (!finished) idle();
    };
    void readLocalThumbnail(projectId, file.id).then((cached) => {
      if (disposed || finished) return;
      if (cached) setBlob(cached.blob);
      if (cached?.version === version) finished = true;
      else idle();
    });
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const event of events) window.addEventListener(event, idle, { passive: true });
    window.addEventListener("focus", retry);
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      setPrepared(undefined);
      for (const event of events) window.removeEventListener(event, idle);
      window.removeEventListener("focus", retry);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [api, projectId, file.id, file.updatedAt, visible, enabled]);
  const assetURL = useCallback((id: string) => prepared?.design.assets[id] ?? "", [prepared]);
  return (
    <div ref={container} className="local-file-preview" aria-hidden="true">
      {url ? <img src={url} alt="" draggable={false} /> : <Icon name="frame" size={24} />}
      {prepared && (
        <ThumbnailRenderer
          allowMissingImages
          pixelRatio={2}
          snapshot={{
            document: { content: prepared.design.document, revision: 0 },
            frames: [],
            rectangles: [],
          }}
          signal={prepared.signal}
          assetUrl={assetURL}
          onComplete={prepared.complete}
          onError={prepared.fail}
        />
      )}
    </div>
  );
}
