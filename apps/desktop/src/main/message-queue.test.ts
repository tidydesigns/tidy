import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import { applyQueueAction, MAX_QUEUED_MESSAGES } from "../shared/message-queue";
import type { startHarness } from "./harnesses";
import type { Thread } from "../shared/contracts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(native = false, finishOnStop = true) {
  const directory = await mkdtemp(join(tmpdir(), "tidy-queue-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new ProjectStore(join(directory, "state"));
  await store.initialize();
  const path = join(directory, "project");
  await mkdir(path);
  const { project } = await store.open(path);
  const runs: Array<{
    input: Parameters<typeof startHarness>[0];
    finish(): void;
    fail(error: Error): void;
    stopped: boolean;
    shutdownWait: Promise<void>;
    steers: Array<{ prompt: string }>;
  }> = [];
  const runWaiters = new Map<number, () => void>();
  const service = new WorkspaceService(
    store,
    (input) => {
      const deferred = Promise.withResolvers<void>();
      const shutdown = Promise.withResolvers<void>();
      const steers: Array<{ prompt: string }> = [];
      const run = {
        input,
        finish: () => deferred.resolve(),
        fail: deferred.reject,
        stopped: false,
        shutdownWait: shutdown.promise,
        steers,
      };
      runs.push(run);
      runWaiters.get(runs.length)?.();
      runWaiters.delete(runs.length);
      return {
        get done() {
          if (run.stopped) shutdown.resolve();
          return deferred.promise;
        },
        stop() {
          run.stopped = true;
          if (finishOnStop) deferred.resolve();
        },
        ...(native
          ? {
              async steer(message: { prompt: string }) {
                run.steers.push(message);
                return true;
              },
            }
          : {}),
      };
    },
    async () => "/fixture/agent",
  );
  cleanups.push(async () => {
    for (const run of runs) run.finish();
    await service.close();
  });
  const thread = await service.startThread({
    projectId: project.id,
    harness: native ? "codex" : "claude",
    prompt: "First task",
    designIds: [],
  });
  const session = randomUUID();
  runs[0].input.onUpdate({ type: "session", id: session });
  const enqueue = (text: string, delivery: "queue" | "steer" = "queue") =>
    service.sendMessage({
      projectId: project.id,
      threadId: thread.id,
      messageId: randomUUID(),
      text,
      delivery,
    });
  const read = () => service.readThread(project.id, thread.id);
  const action = (value: Parameters<typeof service.updateMessageQueue>[0]["action"]) =>
    service.updateMessageQueue({ projectId: project.id, threadId: thread.id, action: value });
  const waitForRun = (count: number) => {
    if (runs.length >= count) return Promise.resolve();
    const deferred = Promise.withResolvers<void>();
    runWaiters.set(count, deferred.resolve);
    return deferred.promise;
  };
  const waitForStatus = async (status: Thread["status"]) => {
    const deferred = Promise.withResolvers<void>();
    const unsubscribe = service.subscribe((event) => {
      if (
        event.type === "thread" &&
        event.thread.id === thread.id &&
        event.thread.status === status
      )
        deferred.resolve();
    });
    try {
      if ((await read()).status !== status) await deferred.promise;
    } finally {
      unsubscribe();
    }
  };
  return {
    directory,
    project,
    store,
    service,
    thread,
    runs,
    enqueue,
    read,
    action,
    session,
    waitForRun,
    waitForStatus,
  };
}

test("follow-ups persist outside the transcript and run in order with the same session", async () => {
  const { enqueue, read, runs, store, project, thread, session, waitForRun } = await fixture();
  await Promise.all([enqueue("Second"), enqueue("Third")]);
  expect(runs).toHaveLength(1);
  expect((await read()).messages.map((item) => item.text)).toEqual(["First task"]);
  expect(
    (await store.readThread(project.id, thread.id)).queuedMessages?.map((item) => item.text),
  ).toEqual(["Second", "Third"]);
  runs[0].finish();
  await waitForRun(2);
  expect(runs[1].input.prompt).toEndWith("Second");
  expect(runs[1].input.sessionId).toBe(session);
  runs[1].finish();
  await waitForRun(3);
  expect(runs[2].input.prompt).toEndWith("Third");
  expect((await read()).queuedMessages).toEqual([]);
  expect(
    (await read()).messages.filter((item) => item.role === "user").map((item) => item.text),
  ).toEqual(["First task", "Second", "Third"]);
});

test("edit, reorder and remove affect only waiting messages", async () => {
  const { enqueue, action, read, runs, waitForRun } = await fixture();
  await enqueue("Second");
  const state = await enqueue("Third");
  const [second, third] = state.queuedMessages!;
  await action({ kind: "edit", messageId: third.id, text: "Revised third" });
  await action({ kind: "move", messageId: third.id, beforeId: second.id });
  expect((await read()).queuedMessages?.map((item) => item.text)).toEqual([
    "Revised third",
    "Second",
  ]);
  await action({ kind: "remove", messageId: second.id });
  runs[0].finish();
  await waitForRun(2);
  expect(runs[1].input.prompt).toEndWith("Revised third");
  await expect(action({ kind: "remove", messageId: third.id })).rejects.toThrow("left the queue");
});

test("native steering promotes a queued message without interrupting or draining the others", async () => {
  const { enqueue, action, runs, read, waitForRun } = await fixture(true);
  await enqueue("Later");
  const state = await enqueue("Change direction");
  const message = state.queuedMessages![1];
  await action({ kind: "steer", messageId: message.id });
  expect(runs).toHaveLength(1);
  expect(runs[0].stopped).toBe(false);
  expect(runs[0].steers[0].prompt).toEndWith("Change direction");
  expect((await read()).messages.at(-1)?.id).toBe(message.id);
  expect((await read()).queuedMessages?.map((item) => item.text)).toEqual(["Later"]);
  runs[0].finish();
  await waitForRun(2);
  expect(runs[1].input.prompt).toEndWith("Later");
});

test("steering without native support stops and resumes the same session before draining", async () => {
  const { enqueue, runs, session, read, waitForRun } = await fixture();
  await enqueue("Later");
  await enqueue("Change direction", "steer");
  expect(runs[0].stopped).toBe(true);
  expect(runs).toHaveLength(2);
  expect(runs[1].input.sessionId).toBe(session);
  expect(runs[1].input.prompt).toEndWith("Change direction");
  expect((await read()).queuedMessages?.map((item) => item.text)).toEqual(["Later"]);
  runs[1].finish();
  await waitForRun(3);
  expect(runs[2].input.prompt).toEndWith("Later");
});

test("Stop holds the queue until a message is explicitly sent", async () => {
  const { enqueue, service, project, thread, runs, read, action, waitForRun, waitForStatus } =
    await fixture();
  await enqueue("Later");
  await service.stopThread(project.id, thread.id);
  await waitForStatus("stopped");
  await enqueue("Also later");
  expect(runs).toHaveLength(1);
  expect((await read()).queuedMessages).toHaveLength(2);
  await action({ kind: "steer", messageId: (await read()).queuedMessages![1].id });
  expect(runs).toHaveLength(2);
  expect(runs[1].input.prompt).toEndWith("Also later");
  expect((await read()).queuedMessages?.map((message) => message.text)).toEqual(["Later"]);
  runs[1].finish();
  await waitForRun(3);
  expect(runs[2].input.prompt).toEndWith("Later");
});

test("failed turns preserve the queue for retry", async () => {
  const { enqueue, runs, read, action, waitForStatus } = await fixture();
  await enqueue("Later");
  runs[0].fail(new Error("Provider unavailable"));
  await waitForStatus("failed");
  expect(runs).toHaveLength(1);
  expect((await read()).queuedMessages).toHaveLength(1);
  await action({ kind: "steer", messageId: (await read()).queuedMessages![0].id });
  expect(runs).toHaveLength(2);
});

test("restart retains queue order without executing imported project instructions", async () => {
  const { enqueue, service, store, directory, project, thread, runs } = await fixture();
  await enqueue("Do this later");
  await enqueue("Then this");
  await service.close();
  const reopened = new ProjectStore(join(directory, "state"));
  await reopened.initialize();
  await reopened.recover();
  let launched = false;
  const restored = new WorkspaceService(reopened, () => {
    launched = true;
    throw new Error("Unexpected launch");
  });
  cleanups.push(() => restored.close());
  const value = await restored.readThread(project.id, thread.id);
  expect(value.queuedMessages?.map((item) => item.text)).toEqual(["Do this later", "Then this"]);
  expect(launched).toBe(false);
  expect(runs).toHaveLength(1);
  expect((await store.snapshot(project.id)).threads[0].queuedMessageCount).toBe(2);
});

test("completion racing a new message neither loses nor duplicates it", async () => {
  const { enqueue, runs, read, waitForRun, waitForStatus } = await fixture();
  const pending = enqueue("Racing follow-up");
  runs[0].finish();
  await pending;
  await waitForRun(2);
  runs[1].finish();
  await waitForStatus("completed");
  expect(runs).toHaveLength(2);
  expect((await read()).messages.filter((item) => item.text === "Racing follow-up")).toHaveLength(
    1,
  );
});

test("queue ownership, duplicate IDs, limits and empty edits are enforced", async () => {
  const { enqueue, service, project, thread, read, action } = await fixture();
  const state = await enqueue("Later");
  const message = state.queuedMessages![0];
  await expect(
    service.sendMessage({
      projectId: randomUUID(),
      threadId: thread.id,
      text: "wrong",
      delivery: "queue",
    }),
  ).rejects.toThrow("another project");
  await expect(
    service.updateMessageQueue({
      projectId: randomUUID(),
      threadId: thread.id,
      action: { kind: "steer", messageId: message.id },
    }),
  ).rejects.toThrow("another project");
  await expect(
    service.sendMessage({
      projectId: project.id,
      threadId: thread.id,
      messageId: message.id,
      text: "duplicate",
      delivery: "queue",
    }),
  ).rejects.toThrow("already sent");
  await expect(action({ kind: "edit", messageId: message.id, text: "" })).rejects.toThrow(
    "Write a message",
  );
  await Promise.all(
    Array.from({ length: MAX_QUEUED_MESSAGES - 1 }, (_, i) => enqueue(`Queued ${i}`)),
  );
  await expect(enqueue("Too many")).rejects.toThrow("full");
  expect((await read()).queuedMessages).toHaveLength(MAX_QUEUED_MESSAGES);
});

test("failed queue persistence rolls back only the attempted queue change", async () => {
  const { store, enqueue, read, runs } = await fixture();
  await enqueue("Retained");
  const write = store.writeThread.bind(store);
  store.writeThread = () => Promise.reject(new Error("Disk full"));
  await expect(enqueue("Not accepted")).rejects.toThrow("Disk full");
  store.writeThread = write;
  expect((await read()).queuedMessages?.map((item) => item.text)).toEqual(["Retained"]);
  expect(runs).toHaveLength(1);
});

test("reordering is total for removed neighbors and preserves message identities", () => {
  const first = { id: randomUUID(), text: "First" },
    second = { id: randomUUID(), text: "Second" };
  const queue = [first, second];
  expect(
    applyQueueAction(queue, { kind: "move", messageId: first.id, beforeId: randomUUID() }),
  ).toBe(queue);
  expect(applyQueueAction(queue, { kind: "move", messageId: first.id, beforeId: null })).toEqual([
    second,
    first,
  ]);
});

test("Stop during a queued launch keeps its message available to send later", async () => {
  const { enqueue, service, store, project, thread, runs, read, action, waitForStatus } =
    await fixture();
  await enqueue("Retain me");
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = store.writeThread.bind(store);
  let blocked = false;
  store.writeThread = async (value) => {
    if (!blocked && value.status === "running" && value.messages.at(-1)?.text === "Retain me") {
      blocked = true;
      admitted.resolve();
      await release.promise;
    }
    return write(value);
  };
  runs[0].finish();
  await admitted.promise;
  await service.stopThread(project.id, thread.id);
  release.resolve();
  await waitForStatus("stopped");
  expect(runs).toHaveLength(1);
  expect((await read()).queuedMessages?.map((item) => item.text)).toEqual(["Retain me"]);
  expect((await read()).messages.some((item) => item.text === "Retain me")).toBe(false);
  await action({ kind: "steer", messageId: (await read()).queuedMessages![0].id });
  expect(runs).toHaveLength(2);
});

test("attachments stay with queued messages and reach the delivered turn", async () => {
  const { service, store, project, thread, runs, read, waitForRun } = await fixture();
  const attachment = await store.addAttachment(
    project.id,
    "notes.txt",
    "data:text/plain;base64,bm90ZXM=",
  );
  await service.sendMessage({
    projectId: project.id,
    threadId: thread.id,
    text: "Read these notes",
    attachmentIds: [attachment.id],
    delivery: "queue",
  });
  expect((await read()).queuedMessages?.[0].attachments?.[0].name).toBe("notes.txt");
  runs[0].finish();
  await waitForRun(2);
  expect(runs[1].input.prompt).toContain("notes.txt");
  expect((await read()).messages.at(-1)?.attachments?.[0].id).toBe(attachment.id);
});

test("streaming patches do not resend queued message bodies", async () => {
  const { enqueue, service, runs } = await fixture();
  const text = "queued text ".repeat(1000);
  await enqueue(text);
  const patch = Promise.withResolvers<string>();
  const unsubscribe = service.subscribe((event) => {
    if (event.type === "thread-patch") patch.resolve(JSON.stringify(event));
  });
  runs[0].input.onUpdate({ type: "message", id: "answer", text: "A short update" });
  const event = await patch.promise;
  unsubscribe();
  expect(event).not.toContain("queued text");
  expect(event).toContain('"queuedMessageCount":1');
});

test("Stop cancels a queued send-now request waiting behind persistence", async () => {
  const { enqueue, service, store, project, thread, runs, read, action, waitForStatus } =
    await fixture();
  await service.stopThread(project.id, thread.id);
  await waitForStatus("stopped");
  const state = await enqueue("Keep waiting");
  const message = state.queuedMessages?.[0];
  if (!message) throw new Error("Expected the queued message");
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = store.writeThread.bind(store);
  let blocked = false;
  store.writeThread = async (value) => {
    if (!blocked) {
      blocked = true;
      admitted.resolve();
      await release.promise;
    }
    return write(value);
  };
  const editing = action({ kind: "edit", messageId: message.id, text: "Updated instruction" });
  await admitted.promise;
  const sending = action({ kind: "steer", messageId: message.id });
  await service.stopThread(project.id, thread.id);
  release.resolve();
  await Promise.all([editing, sending]);
  expect(runs).toHaveLength(1);
  expect((await read()).queuedMessages?.map((item) => item.text)).toEqual(["Updated instruction"]);
});

test("delivery rejects an attachment changed after enqueue and retains the message", async () => {
  const { service, store, project, thread, runs, action, read } = await fixture(true);
  const attachment = await store.addAttachment(
    project.id,
    "notes.txt",
    "data:text/plain;base64,bm90ZXM=",
  );
  const state = await service.sendMessage({
    projectId: project.id,
    threadId: thread.id,
    text: "Read these notes",
    attachmentIds: [attachment.id],
    delivery: "queue",
  });
  const message = state.queuedMessages?.[0];
  if (!message) throw new Error("Expected the queued message");
  const file = await store.resolveAttachment(project.id, attachment.id);
  await writeFile(file.path, "changed attachment");
  const result = await action({ kind: "steer", messageId: message.id });
  expect(result.queueError).toContain("changed on disk");
  expect((await read()).queuedMessages?.[0]?.id).toBe(message.id);
  expect(runs).toHaveLength(1);
  expect(runs[0].steers).toHaveLength(0);
});

test.each([false, true])(
  "Send now waits for shutdown and honors a later Stop (%s)",
  async (stopAgain) => {
    const { enqueue, service, project, thread, runs, action, read } = await fixture(false, false);
    const queued = await enqueue("Replacement instruction");
    const message = queued.queuedMessages?.[0];
    if (!message) throw new Error("Expected the queued message");
    await service.stopThread(project.id, thread.id);
    const sending = action({ kind: "steer", messageId: message.id });
    await runs[0].shutdownWait;
    if (stopAgain) await service.stopThread(project.id, thread.id);
    expect(runs).toHaveLength(1);
    runs[0].finish();
    await sending;
    expect(runs).toHaveLength(stopAgain ? 1 : 2);
    if (stopAgain) expect((await read()).queuedMessages?.[0]?.id).toBe(message.id);
    else {
      expect(runs[1].input.prompt).toEndWith("Replacement instruction");
      expect((await read()).queuedMessages).toEqual([]);
    }
  },
);
