import { videoFileTransfers } from "./video-task-queue";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../../../shared/contracts/desktop";
import { loadVideoSource, type VideoInput } from "./load-video-source";
import { videoMemoryBudget } from "./video-memory-budget";

export type VideoState =
  | { kind: "loading"; loaded: number; total: number | null }
  | { kind: "ready"; url: string }
  | { kind: "unloaded" }
  | { kind: "error"; message: string };
const loading: VideoState = { kind: "loading", loaded: 0, total: null };

export function useVideoSource(
  api: Pick<DesktopAPI, "readVideoChunk">,
  input: VideoInput,
  enabled: boolean,
  visible = true,
) {
  const { projectId, threadId, href } = input;
  const key = JSON.stringify([projectId, threadId, href]);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState({ api, key, attempt, state: loading });
  const priority = useRef(visible);
  useLayoutEffect(() => {
    priority.current = visible;
  }, [visible]);
  const retained = useRef<ReturnType<typeof videoMemoryBudget.retain>>(undefined);
  useEffect(() => {
    if (visible) retained.current?.touch();
  }, [visible]);
  useEffect(() => {
    if (!enabled) {
      setSource({ api, key, attempt, state: loading });
      return;
    }
    const controller = new AbortController();
    let url: string | undefined;
    let lease: ReturnType<typeof videoMemoryBudget.retain> | undefined;
    const update = (state: VideoState) => setSource({ api, key, attempt, state });
    const disposeURL = () => {
      if (url) URL.revokeObjectURL(url);
      url = undefined;
    };
    update(loading);
    void videoFileTransfers
      .run({
        signal: controller.signal,
        priority: () => priority.current,
        task: () =>
          loadVideoSource({
            api,
            input: { projectId, threadId, href },
            signal: controller.signal,
            onProgress: (loaded, total) => update({ kind: "loading", loaded, total }),
          }),
      })
      .then(({ blob, size }) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        lease = videoMemoryBudget.retain({
          size,
          priority: () => priority.current,
          evict: () => {
            disposeURL();
            update({ kind: "unloaded" });
          },
        });
        retained.current = lease;
        update({ kind: "ready", url });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          disposeURL();
          update({
            kind: "error",
            message: error instanceof Error ? error.message : "Could not load this recording.",
          });
        }
      });
    return () => {
      controller.abort();
      disposeURL();
      lease?.release();
      if (retained.current === lease) retained.current = undefined;
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
