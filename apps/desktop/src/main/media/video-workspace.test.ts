import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceService } from "../workspace/workspace-service";
import { ProjectStore } from "../workspace/project-store";
import { runVideoTool } from "./video-processing";
import type { startHarness } from "../harnesses/harnesses";
import type { Thread } from "../../shared/contracts/desktop";
import { applyThreadPatch } from "../../shared/models/thread-updates";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function until(service: WorkspaceService, predicate: (thread: Thread) => boolean) {
  return new Promise<Thread>((resolve, reject) => {
    const threads = new Map<string, Thread>();
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Video update timed out"));
    }, 10_000);
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "thread") threads.set(event.thread.id, structuredClone(event.thread));
      if (event.type === "thread-patch" && threads.has(event.thread.id))
        threads.set(event.thread.id, applyThreadPatch(threads.get(event.thread.id)!, event));
      const thread =
        event.type === "thread" || event.type === "thread-patch"
          ? threads.get(event.thread.id)
          : undefined;
      if (thread && predicate(thread)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(structuredClone(thread));
      }
    });
  });
}
test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "completed assistant video links publish in the background without overwriting a follow-up",
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "tidy-video-workspace-")));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const store = new ProjectStore(join(directory, "state"));
    await store.initialize();
    const root = join(directory, "project");
    await mkdir(root);
    const { project } = await store.open(root);
    await runVideoTool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=30",
        "-t",
        "1",
        "-c:v",
        "mpeg4",
        join(root, "demo.avi"),
      ],
      new AbortController().signal,
    );
    const runs: Array<{ input: Parameters<typeof startHarness>[0]; complete: () => void }> = [];
    const service = new WorkspaceService(
      store,
      (input) => {
        const done = Promise.withResolvers<void>();
        runs.push({ input, complete: () => done.resolve() });
        return { done: done.promise, stop: () => done.resolve() };
      },
      async () => "/fixture/agent",
      async () => {},
    );
    cleanups.push(() => service.close());
    const thread = await service.startThread({
      projectId: project.id,
      harness: "codex",
      prompt: "Make a video",
      designIds: [],
    });
    expect(runs[0].input.prompt).toContain("Tidy registers up to four linked");
    runs[0].input.onUpdate({ type: "message", id: "result", text: "[Video](./demo.avi)" });
    const processing = until(service, (thread) =>
      thread.messages.some((message) => message.videos?.[0]?.status === "processing"),
    );
    const ready = until(service, (thread) =>
      thread.messages.some((message) => message.videos?.[0]?.status === "ready"),
    );
    runs[0].complete();
    await processing;
    await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Keep going" });
    runs[1].input.onUpdate({ type: "message", id: "follow-up", text: "Next response" });
    await ready;
    const latest = await service.readThread(project.id, thread.id);
    expect(latest.status).toBe("running");
    expect(latest.messages.map((message) => message.text)).toContain("Next response");
    const video = latest.messages[1].videos![0];
    expect(video.transcoded).toBe(true);
    const request = {
      projectId: project.id,
      threadId: thread.id,
      artifactId: video.id,
      variant: "playback" as const,
      offset: 0,
      length: 32,
    };
    expect(Buffer.from((await service.readVideo(request)).base64, "base64")).toHaveLength(32);
    await expect(service.readVideo({ ...request, artifactId: randomUUID() })).rejects.toThrow();
    await expect(service.readVideo({ ...request, projectId: randomUUID() })).rejects.toThrow();
    await expect(service.readVideo({ ...request, length: 1_048_577 })).rejects.toThrow();
    runs[1].complete();
  },
  20_000,
);
