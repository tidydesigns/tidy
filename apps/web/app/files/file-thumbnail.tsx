"use client";
import Image from "next/image";
import dynamic from "next/dynamic";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fileVersion, fileVersionAtLeast } from "@/lib/design/file-version";
import {
  thumbnailFileVersion,
  thumbnailIsCurrent,
  thumbnailVersion as encodeThumbnailVersion,
} from "@/lib/design/thumbnail-version";
import type { Snapshot } from "./thumbnail-renderer";
import { observeThumbnail } from "./thumbnail-visibility";
import { prepareThumbnail, queueThumbnail, uploadThumbnail } from "./thumbnail-queue";
import {
  cachedThumbnail,
  cacheThumbnail,
  removeCachedThumbnail,
  type CachedThumbnail,
} from "./thumbnail-cache";
const ThumbnailRenderer = dynamic(
  () => import("./thumbnail-renderer").then((module) => module.ThumbnailRenderer),
  { ssr: false },
);
type VersionResponse = {
  versions: Record<string, string>;
  thumbnailVersions?: Record<string, string | null>;
};
type ThumbnailVersions = VersionResponse & { register: (fileId: string) => () => void };

const ThumbnailVersionsContext = createContext<ThumbnailVersions | null>(null);

export function FileThumbnailUpdates({ children }: { children: ReactNode }) {
  const visibleIds = useRef(new Map<string, number>());
  const checking = useRef(false);
  const [hasVisible, setHasVisible] = useState(false);
  const [state, setState] = useState<VersionResponse>({ versions: {}, thumbnailVersions: {} });

  const register = useCallback((fileId: string) => {
    visibleIds.current.set(fileId, (visibleIds.current.get(fileId) ?? 0) + 1);
    if (visibleIds.current.size === 1) setHasVisible(true);
    return () => {
      const count = visibleIds.current.get(fileId) ?? 0;
      if (count > 1) visibleIds.current.set(fileId, count - 1);
      else visibleIds.current.delete(fileId);
      if (!visibleIds.current.size) setHasVisible(false);
    };
  }, []);

  const checkVersions = useCallback(async (signal: AbortSignal) => {
    if (document.visibilityState === "hidden" || checking.current) return;
    const ids = [...visibleIds.current.keys()].filter((id) => !id.startsWith("pending-"));
    if (!ids.length) return;
    checking.current = true;
    try {
      for (let index = 0; index < ids.length; index += 100) {
        const response = await fetch("/api/files/versions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: ids.slice(index, index + 100) }),
          cache: "no-store",
          signal,
        });
        if (!response.ok) throw new Error("Could not check file versions.");
        const result = (await response.json()) as VersionResponse;
        if (signal.aborted) return;
        setState((current) => {
          const versions = Object.entries(result.versions).filter(
            ([id, version]) => current.versions[id] !== version,
          );
          const thumbnails = Object.entries(result.thumbnailVersions ?? {}).filter(
            ([id, version]) => current.thumbnailVersions?.[id] !== version,
          );
          return versions.length || thumbnails.length
            ? {
                versions: { ...current.versions, ...Object.fromEntries(versions) },
                thumbnailVersions: {
                  ...current.thumbnailVersions,
                  ...Object.fromEntries(thumbnails),
                },
              }
            : current;
        });
      }
    } catch {
      // Keep the current thumbnails; the next check will retry.
    } finally {
      checking.current = false;
    }
  }, []);

  useEffect(() => {
    if (!hasVisible) return;
    const controller = new AbortController();
    const check = () => {
      void checkVersions(controller.signal);
    };
    check();
    const interval = window.setInterval(check, 10_000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [hasVisible, checkVersions]);

  return (
    <ThumbnailVersionsContext.Provider value={{ ...state, register }}>
      {children}
    </ThumbnailVersionsContext.Provider>
  );
}

type RenderJob = {
  snapshot: Snapshot;
  signal: AbortSignal;
  onComplete: (blob: Blob) => void;
  onError: (error: unknown) => void;
};
export function FileThumbnail({
  fileId,
  initialVersion,
  thumbnailVersion,
  canGenerate = false,
  eager = false,
  cacheScope,
  snapshot: providedSnapshot,
  prewarm = false,
}: {
  fileId: string;
  initialVersion: string;
  thumbnailVersion: string | null;
  canGenerate?: boolean;
  eager?: boolean;
  cacheScope?: string;
  snapshot?: Snapshot;
  prewarm?: boolean;
}) {
  const updates = useContext(ThumbnailVersionsContext);
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager || prewarm);
  const [version, setVersion] = useState(thumbnailFileVersion(thumbnailVersion));
  const [source, setSource] = useState(
    thumbnailVersion
      ? `/api/files/${encodeURIComponent(fileId)}/thumbnail?version=${encodeURIComponent(thumbnailVersion)}`
      : "",
  );
  const [job, setJob] = useState<RenderJob | null>(null);
  const [retry, setRetry] = useState(0);
  const [rendered, setRendered] = useState<CachedThumbnail | null>(null);
  const checkedVersion = updates?.versions[fileId] || initialVersion;
  const register = updates?.register;
  const persistedVersion = updates?.thumbnailVersions?.[fileId] ?? thumbnailVersion;
  const objectUrl = useRef("");
  const failedVersion = useRef<string | null>(null);
  const appliedCache = useRef<CachedThumbnail | null>(null);
  const visibilityChanged = useEffectEvent((isVisible: boolean) => {
    setVisible(isVisible);
    if (isVisible || !rendered) return;
    // Cards stay mounted when scrolling. Release their blobs/decoded images;
    // only the bounded shared cache retains previews outside the viewport.
    const known = rendered.persisted ? encodeThumbnailVersion(rendered.version) : persistedVersion;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = "";
    appliedCache.current = null;
    setRendered(null);
    setSource(known ? thumbnailUrl(fileId, known) : "");
    setVersion(thumbnailFileVersion(known));
  });
  useEffect(() => {
    const element = container.current;
    if (!prewarm && element) return observeThumbnail(element, visibilityChanged);
  }, [prewarm]);
  useEffect(() => {
    if (visible && register && !fileId.startsWith("pending-")) return register(fileId);
  }, [visible, register, fileId]);
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = "";
      appliedCache.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!visible || fileId.startsWith("pending-")) return;
    const publish = (value: CachedThumbnail) => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(value.blob);
      cacheThumbnail(cacheScope, fileId, value);
      appliedCache.current = value;
      setSource(objectUrl.current);
      setVersion(value.version);
      setRendered(value);
      setJob(null);
    };
    const cached = cachedThumbnail(cacheScope, fileId);
    if (cached && fileVersionAtLeast(cached.version, checkedVersion)) {
      if (appliedCache.current !== cached) publish(cached);
      return;
    }
    if (fileVersionAtLeast(version, checkedVersion)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    void prepareThumbnail(async () => {
      // Another editor may already have published this revision. Reuse its PNG.
      if (
        persistedVersion !== failedVersion.current &&
        thumbnailIsCurrent(persistedVersion, checkedVersion)
      ) {
        const response = await fetch(thumbnailUrl(fileId, persistedVersion!), { signal });
        if (response.ok) {
          const blob = await response.blob();
          signal.throwIfAborted();
          publish({ version: thumbnailFileVersion(persistedVersion), blob, persisted: true });
          return;
        }
        if ([401, 403].includes(response.status)) throw new Error("Thumbnail access ended.");
        failedVersion.current = persistedVersion;
      }
      const snapshot =
        providedSnapshot ??
        (await (async () => {
          const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/snapshot`, {
            cache: "no-store",
            signal,
          });
          if (!response.ok) throw new Error("Could not load thumbnail source.");
          return (await response.json()) as Snapshot & { updatedAt: string };
        })());
      signal.throwIfAborted();
      const currentVersion =
        "updatedAt" in snapshot
          ? fileVersion(snapshot.updatedAt as string, snapshot.document?.revision)
          : initialVersion;
      await queueThumbnail(async () => {
        const blob = await new Promise<Blob>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          setJob({
            snapshot,
            signal,
            onComplete: (blob) => {
              signal.removeEventListener("abort", abort);
              resolve(blob);
            },
            onError: (error) => {
              signal.removeEventListener("abort", abort);
              reject(error);
            },
          });
        });
        signal.throwIfAborted();
        // Publish immediately. The separate persistence effect retries the same
        // blob, so a slow/failed POST cannot hide a finished preview or rerender it.
        publish({ version: currentVersion, blob, persisted: false });
      }, signal);
    }, signal).catch(() => {
      if (!controller.signal.aborted) {
        setJob(null);
        timer = setTimeout(() => setRetry((value) => value + 1), 10_000);
      }
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      setJob((current) => (current?.signal === signal ? null : current));
    };
  }, [
    visible,
    fileId,
    checkedVersion,
    version,
    initialVersion,
    persistedVersion,
    providedSnapshot,
    cacheScope,
    retry,
  ]);
  useEffect(() => {
    if (!visible || !canGenerate || !rendered || rendered.persisted) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const persist = async () => {
      try {
        const status = await uploadThumbnail(async () => {
          const response = await fetch(
            thumbnailUrl(fileId, encodeThumbnailVersion(rendered.version)),
            {
              method: "POST",
              headers: { "Content-Type": "image/png" },
              body: rendered.blob,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
            },
          );
          return response.status;
        }, controller.signal);
        if (controller.signal.aborted) return;
        if (status === 204) {
          const value = { ...rendered, persisted: true };
          cacheThumbnail(cacheScope, fileId, value);
          setRendered((current) => (current === rendered ? value : current));
          return;
        }
        if ([401, 403, 404, 409, 413].includes(status)) return;
      } catch {
        /* Retry persistence without regenerating or removing the image. */
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void persist(), 10_000);
    };
    void persist();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [visible, canGenerate, rendered, fileId, cacheScope]);
  return (
    <div ref={container} className="relative h-full w-full overflow-hidden bg-primary-white">
      {source && visible && !prewarm ? (
        <Image
          src={source}
          alt=""
          unoptimized
          width={512}
          height={320}
          loading="eager"
          draggable={false}
          onError={() => {
            failedVersion.current = persistedVersion;
            removeCachedThumbnail(cacheScope, fileId);
            setRendered(null);
            setSource("");
            setVersion("");
            setRetry((value) => value + 1);
          }}
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="absolute left-1/2 top-1/2 h-24 w-36 -translate-x-1/2 -translate-y-1/2 border border-dashed border-primary-black/20" />
      )}
      {job && visible && <ThumbnailRenderer {...job} />}
    </div>
  );
}

const thumbnailUrl = (fileId: string, version: string) =>
  `/api/files/${encodeURIComponent(fileId)}/thumbnail?version=${encodeURIComponent(version)}`;
