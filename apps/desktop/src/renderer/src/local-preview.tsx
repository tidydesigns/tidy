import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@tidy/editor/components/ui/icon";
import { ThumbnailRenderer } from "@tidy/editor/components/files/thumbnail-renderer";
import { queueThumbnail } from "@tidy/editor/lib/thumbnail-queue";
import type { DesktopAPI, DesignSummary, LocalDesign } from "../../shared/contracts";
import {
  cacheLocalThumbnail,
  cachedLocalThumbnail,
  readLocalThumbnail,
} from "./local-thumbnail-cache";

type Prepared = {
  design: LocalDesign;
  signal: AbortSignal;
  complete(blob: Blob): void;
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
    let complete = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const prepare = async () => {
      if (disposed || complete || document.hidden) return;
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), 15_000);
      try {
        await queueThumbnail(async () => {
          const design = await api.previewDesign(projectId, file.id);
          request.signal.throwIfAborted();
          const result = await new Promise<Blob>((resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            });
            setPrepared({ design, signal: request.signal, complete: resolve, fail: reject });
          });
          request.signal.throwIfAborted();
          complete = true;
          setBlob(result);
          setPrepared(undefined);
          void cacheLocalThumbnail(projectId, file.id, version, result);
        }, request.signal);
      } catch {
        if (!disposed && controller === request) setPrepared(undefined);
      } finally {
        clearTimeout(timeout);
      }
    };
    const idle = () => {
      controller?.abort();
      clearTimeout(timer);
      setPrepared(undefined);
      if (!disposed && !complete) timer = setTimeout(() => void prepare(), 200);
    };
    void readLocalThumbnail(projectId, file.id).then((cached) => {
      if (disposed || complete) return;
      if (cached) setBlob(cached.blob);
      if (cached?.version === version) complete = true;
      else idle();
    });
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const event of events) window.addEventListener(event, idle, { passive: true });
    document.addEventListener("visibilitychange", idle);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      setPrepared(undefined);
      for (const event of events) window.removeEventListener(event, idle);
      document.removeEventListener("visibilitychange", idle);
    };
  }, [api, projectId, file.id, file.updatedAt, visible, enabled]);
  const assetURL = useCallback((id: string) => prepared?.design.assets[id] ?? "", [prepared]);
  return (
    <div ref={container} className="local-file-preview" aria-hidden="true">
      {url ? <img src={url} alt="" draggable={false} /> : <Icon name="frame" size={24} />}
      {prepared && (
        <ThumbnailRenderer
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
