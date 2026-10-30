import { useEffect, useState } from "react";
import type { DesktopAPI } from "../../../shared/contracts/desktop";
import { MAX_VIDEO_BYTES, type VideoChunkRequest } from "../../../shared/contracts/video-preview";

export type VideoInput = Pick<VideoChunkRequest, "projectId" | "threadId" | "href">;
export type VideoState =
  | { kind: "loading"; loaded: number; total: number | null }
  | { kind: "ready"; url: string }
  | { kind: "error"; message: string };
const loading: VideoState = { kind: "loading", loaded: 0, total: null };

export function useVideoSource(api: DesktopAPI, input: VideoInput, enabled: boolean) {
  const { projectId, threadId, href } = input;
  const key = JSON.stringify([projectId, threadId, href]);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState({ api, key, attempt, state: loading });
  useEffect(() => {
    if (!enabled) {
      setSource({ api, key, attempt, state: loading });
      return;
    }
    let cancelled = false;
    let url: string | undefined;
    const update = (state: VideoState) => setSource({ api, key, attempt, state });
    update(loading);
    async function load() {
      const parts: ArrayBuffer[] = [];
      let offset = 0;
      let revision: string | undefined;
      let total: number | undefined;
      let mimeType: string | undefined;
      while (!cancelled) {
        const chunk = await api.readVideoChunk({ projectId, threadId, href, offset, revision });
        if (cancelled) return;
        const bytes = await (
          await fetch(`data:application/octet-stream;base64,${chunk.data}`)
        ).arrayBuffer();
        if (cancelled) return;
        if (
          !bytes.byteLength ||
          chunk.size > MAX_VIDEO_BYTES ||
          offset + bytes.byteLength > chunk.size ||
          (total !== undefined && total !== chunk.size) ||
          (revision !== undefined && revision !== chunk.revision) ||
          (mimeType !== undefined && mimeType !== chunk.mimeType)
        )
          throw new Error("The recording changed while loading. Try again.");
        parts.push(bytes);
        offset += bytes.byteLength;
        total = chunk.size;
        revision = chunk.revision;
        mimeType = chunk.mimeType;
        if (offset === total) {
          url = URL.createObjectURL(new Blob(parts, { type: mimeType }));
          update({ kind: "ready", url });
          return;
        }
        update({ kind: "loading", loaded: offset, total });
      }
    }
    void load().catch((error: unknown) => {
      if (!cancelled)
        update({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not load this recording.",
        });
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, projectId, threadId, href, key, attempt, enabled]);
  const state =
    enabled && source.api === api && source.key === key && source.attempt === attempt
      ? source.state
      : loading;
  return {
    state,
    retry: () => setAttempt((value) => value + 1),
    playbackFailed: () =>
      setSource({
        api,
        key,
        attempt,
        state: {
          kind: "error",
          message:
            "This recording could not be played. Try exporting it as an H.264 MP4 or WebM video.",
        },
      }),
  };
}
