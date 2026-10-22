import { useRef, useState } from "react";
import type { DesktopAPI, Thread } from "../../shared/contracts";
import {
  applyQueueAction,
  type MessageDelivery,
  type QueuedMessage,
  type QueueAction,
} from "../../shared/message-queue";

type Pending = {
  id: string;
  threadId: string;
  change:
    | { kind: "enqueue"; message: QueuedMessage }
    | { kind: "action"; action: QueueAction }
    | { kind: "stop" };
};

export function useMessageQueue({
  api,
  thread,
  onThread,
  onError,
  onRecover,
  waitForStart,
}: {
  api: DesktopAPI | undefined;
  thread: Thread | undefined;
  onThread(thread: Thread): void;
  onError(projectId: string, error: unknown): void;
  onRecover(thread: Thread, message: QueuedMessage): void;
  waitForStart(threadId: string): Promise<unknown> | undefined;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const requests = useRef(new Map<string, Promise<void>>());
  let messages = thread?.queuedMessages ?? [];
  for (const item of pending) {
    if (item.threadId !== thread?.id) continue;
    const change = item.change;
    if (change.kind === "action") messages = applyQueueAction(messages, change.action);
    else if (
      change.kind === "enqueue" &&
      !messages.some((message) => message.id === change.message.id) &&
      !thread.messages.some((message) => message.id === change.message.id)
    )
      messages = [...messages, change.message];
  }

  function submit(
    change: Pending["change"],
    request: () => Promise<Thread | void>,
    recover?: QueuedMessage,
  ) {
    if (!thread || !api) return;
    const target = thread;
    const id = crypto.randomUUID();
    setPending((current) => [...current, { id, threadId: target.id, change }]);
    const previous = requests.current.get(target.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await waitForStart(target.id);
        const value = await request();
        if (value) onThread(value);
      } catch (error) {
        onError(target.projectId, error);
        if (recover) onRecover(target, recover);
      } finally {
        setPending((current) => current.filter((item) => item.id !== id));
      }
    });
    requests.current.set(target.id, next);
    void next.finally(() => {
      if (requests.current.get(target.id) === next) requests.current.delete(target.id);
    });
  }

  return {
    messages,
    stopping: pending.some((item) => item.threadId === thread?.id && item.change.kind === "stop"),
    recover(message: QueuedMessage) {
      if (thread) onRecover(thread, message);
    },
    stop() {
      if (!api || !thread) return;
      const pendingRequest = requests.current.has(thread.id) || Boolean(waitForStart(thread.id));
      const immediate = api.stopThread(thread.projectId, thread.id);
      void immediate.catch(() => {});
      submit({ kind: "stop" }, async () => {
        if (pendingRequest) {
          await immediate.catch(() => {});
          await api.stopThread(thread.projectId, thread.id);
        } else await immediate;
      });
    },
    enqueue(message: QueuedMessage, delivery: MessageDelivery) {
      if (!api || !thread) return;
      submit(
        { kind: "enqueue", message },
        () =>
          api.sendMessage({
            projectId: thread.projectId,
            threadId: thread.id,
            messageId: message.id,
            text: message.text,
            attachmentIds: message.attachments?.map((file) => file.id),
            delivery,
          }),
        message,
      );
    },
    change(action: QueueAction) {
      if (!api || !thread) return;
      const original = messages.find((message) => message.id === action.messageId);
      submit(
        { kind: "action", action },
        () => api.updateMessageQueue({ projectId: thread.projectId, threadId: thread.id, action }),
        action.kind === "edit" && original ? { ...original, text: action.text } : undefined,
      );
    },
  };
}
