import { useRef, useState } from "react";
import type { DesktopAPI, Thread } from "../../../../shared/contracts/desktop";
import {
  applyQueueAction,
  type MessageDelivery,
  type QueuedMessage,
  type QueueAction,
} from "../../../../shared/contracts/message-queue";

type Pending = {
  id: string;
  threadId: string;
  change:
    | { kind: "enqueue"; message: QueuedMessage; delivery: MessageDelivery }
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
  api: Pick<DesktopAPI, "sendMessage" | "updateMessageQueue" | "stopThread"> | undefined;
  thread: Thread | undefined;
  onThread(thread: Thread): void;
  onError(projectId: string, error: unknown): void;
  onRecover(thread: Thread, message: QueuedMessage): void;
  waitForStart(threadId: string): Promise<unknown> | undefined;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const requests = useRef(new Map<string, Promise<boolean>>());
  const edits = useRef(new Map<string, Promise<boolean>>());
  const deliveries = useRef(new Set<string>());
  const sending = new Set<string>();
  let messages = thread?.queuedMessages ?? [];
  for (const item of pending) {
    if (item.threadId !== thread?.id) continue;
    const change = item.change;
    if (change.kind === "action") {
      if (change.action.kind === "steer") sending.add(change.action.messageId);
      else messages = applyQueueAction(messages, change.action);
    } else if (
      change.kind === "enqueue" &&
      !thread.messages.some((message) => message.id === change.message.id)
    ) {
      if (!messages.some((message) => message.id === change.message.id))
        messages = [...messages, change.message];
      if (change.delivery === "steer") sending.add(change.message.id);
    }
  }

  function submit(
    change: Pending["change"],
    request: () => Promise<Thread | void>,
    recover?: QueuedMessage,
  ) {
    if (!thread || !api) return;
    const target = thread;
    const messageId =
      change.kind === "action" && change.action.kind === "steer"
        ? change.action.messageId
        : change.kind === "enqueue" && change.delivery === "steer"
          ? change.message.id
          : undefined;
    const deliveryKey = messageId ? `${target.id}:${messageId}` : undefined;
    if (deliveryKey && deliveries.current.has(deliveryKey)) return;
    if (deliveryKey) deliveries.current.add(deliveryKey);
    const id = crypto.randomUUID();
    setPending((current) => [...current, { id, threadId: target.id, change }]);
    const previous = requests.current.get(target.id) ?? Promise.resolve(true);
    const next = previous.then(async () => {
      try {
        await waitForStart(target.id);
        const value = await request();
        if (value) onThread(value);
        return true;
      } catch (error) {
        onError(target.projectId, error);
        if (recover) onRecover(target, recover);
        return false;
      } finally {
        if (deliveryKey) deliveries.current.delete(deliveryKey);
        setPending((current) => current.filter((item) => item.id !== id));
      }
    });
    requests.current.set(target.id, next);
    void next.finally(() => {
      if (requests.current.get(target.id) === next) requests.current.delete(target.id);
    });
    return next;
  }

  return {
    messages,
    sending,
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
        { kind: "enqueue", message, delivery },
        () =>
          api.sendMessage({
            projectId: thread.projectId,
            threadId: thread.id,
            messageId: message.id,
            text: message.text,
            skillId: message.skillId,
            attachmentIds: message.attachments?.map((file) => file.id),
            delivery,
          }),
        message,
      );
    },
    change(action: QueueAction) {
      if (!api || !thread) return;
      const original = messages.find((message) => message.id === action.messageId);
      const key = `${thread.id}:${action.messageId}`;
      const editing = edits.current.get(key);
      const request = submit(
        { kind: "action", action },
        async () => {
          if (action.kind === "steer" && editing && !(await editing)) return;
          return api.updateMessageQueue({
            projectId: thread.projectId,
            threadId: thread.id,
            action,
          });
        },
        action.kind === "edit" && original ? { ...original, text: action.text } : undefined,
      );
      if (action.kind === "edit" && request) {
        edits.current.set(key, request);
        void request.finally(() => {
          if (edits.current.get(key) === request) edits.current.delete(key);
        });
      }
    },
  };
}
