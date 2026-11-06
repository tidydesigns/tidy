import { expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { Thread } from "../../../../shared/contracts/desktop";
import type { QueueAction, QueuedMessage } from "../../../../shared/contracts/message-queue";
import { useMessageQueue } from "./use-message-queue";

type Options = Parameters<typeof useMessageQueue>[0];
type FixtureMessages = [QueuedMessage, QueuedMessage];
type FixtureThread = Thread & { queuedMessages: FixtureMessages };

async function queueProbe(
  run: (probe: {
    queue(): ReturnType<typeof useMessageQueue>;
    initial: FixtureThread;
    requests: Array<{ resolve(thread: Thread): void; reject(error: Error): void }>;
    errors: unknown[];
    recovered: QueuedMessage[];
    actions: QueueAction[];
    stops(): number;
    select(thread: Thread): Promise<void>;
  }) => Promise<void>,
) {
  const window = new Window();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const messages: FixtureMessages = [
    { id: crypto.randomUUID(), text: "Review the changes" },
    { id: crypto.randomUUID(), text: "Check the layout" },
  ];
  const initial: FixtureThread = {
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    revision: 1,
    title: "Queue",
    harness: "codex",
    status: "running",
    updatedAt: new Date().toISOString(),
    designIds: [],
    messages: [],
    queuedMessages: messages,
  };

  const requests: Array<{ resolve(thread: Thread): void; reject(error: Error): void }> = [];
  const request = () =>
    new Promise<Thread>((resolve, reject) => requests.push({ resolve, reject }));
  const actions: QueueAction[] = [];
  let stops = 0;
  const api: NonNullable<Options["api"]> = {
    updateMessageQueue: ({ action }) => {
      actions.push(action);
      return request();
    },
    sendMessage: request,
    stopThread: async () => {
      stops++;
    },
  };
  const errors: unknown[] = [];
  const recovered: QueuedMessage[] = [];
  let state: ReturnType<typeof useMessageQueue> | undefined;
  let select: ((thread: Thread) => void) | undefined;
  function Probe() {
    const [thread, setThread] = useState<Thread>(initial);
    select = setThread;
    state = useMessageQueue({
      api,
      thread,
      onThread: setThread,
      onError: (_projectId, error) => errors.push(error),
      onRecover: (_thread, message) => recovered.push(message),
      waitForStart: () => undefined,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Probe)));
    await run({
      queue() {
        if (!state) throw new Error("Queue did not mount");
        return state;
      },
      initial,
      requests,
      errors,
      recovered,
      actions,
      stops: () => stops,
      select: async (thread) => act(async () => select?.(thread)),
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("send now keeps the message visible until confirmed while other queue actions respond immediately", async () => {
  await queueProbe(async ({ queue, initial, requests }) => {
    const [first, second] = initial.queuedMessages;
    await act(async () => {
      const current = queue();
      current.change({ kind: "steer", messageId: first.id });
      current.change({ kind: "steer", messageId: first.id });
    });
    expect(queue().messages).toEqual(initial.queuedMessages);
    expect([...queue().sending]).toEqual([first.id]);
    await act(async () => queue().change({ kind: "remove", messageId: second.id }));
    expect(queue().messages.map((message) => message.id)).toEqual([first.id]);
    expect(requests).toHaveLength(1);
    const delivered: Thread = {
      ...initial,
      revision: 2,
      messages: [{ ...first, role: "user" }],
      queuedMessages: [second],
    };
    await act(async () => requests[0].resolve(delivered));
    expect(queue().messages).toEqual([]);
    expect(queue().sending.size).toBe(0);
    expect(requests).toHaveLength(2);
    await act(async () => requests[1].resolve({ ...delivered, revision: 3, queuedMessages: [] }));
    expect(queue().messages).toEqual([]);
    expect(requests).toHaveLength(2);
  });
});

test("failed send now retains a retryable message for transport and delivery errors", async () => {
  await queueProbe(async ({ queue, initial, requests, errors }) => {
    const [first] = initial.queuedMessages;
    await act(async () => queue().change({ kind: "steer", messageId: first.id }));
    await act(async () => requests[0].reject(new Error("Connection lost")));
    expect(errors).toHaveLength(1);
    expect(queue().messages).toEqual(initial.queuedMessages);
    expect(queue().sending.size).toBe(0);
    await act(async () => queue().change({ kind: "steer", messageId: first.id }));
    await act(async () =>
      requests[1].resolve({ ...initial, revision: 2, queueError: "Try again" }),
    );
    expect(queue().messages).toEqual(initial.queuedMessages);
    expect(queue().sending.size).toBe(0);
  });
});

test("direct steering stays visibly pending and sending indicators follow the selected thread", async () => {
  await queueProbe(async ({ queue, initial, requests, select }) => {
    const message = { id: crypto.randomUUID(), text: "Use this instruction now" };
    await act(async () => queue().enqueue(message, "steer"));
    expect(queue().messages.at(-1)).toEqual(message);
    expect(queue().sending.has(message.id)).toBe(true);
    await select({ ...initial, id: crypto.randomUUID(), queuedMessages: [] });
    expect(queue().messages).toEqual([]);
    expect(queue().sending.size).toBe(0);
    await select({ ...initial, queuedMessages: [...initial.queuedMessages, message] });
    expect(queue().messages.filter((item) => item.id === message.id)).toHaveLength(1);
    expect(queue().sending.has(message.id)).toBe(true);
    await act(async () =>
      requests[0].resolve({
        ...initial,
        revision: 2,
        messages: [{ ...message, role: "user" }],
      }),
    );
    expect(queue().messages).toEqual(initial.queuedMessages);
    expect(queue().sending.size).toBe(0);
  });
});

test("editing then sending preserves request order and delivers the confirmed edit", async () => {
  await queueProbe(async ({ queue, initial, requests, actions }) => {
    const [first, second] = initial.queuedMessages;
    const edited = { ...first, text: "Corrected instruction" };
    await act(async () => {
      queue().change({ kind: "edit", messageId: first.id, text: edited.text });
      queue().change({ kind: "steer", messageId: first.id });
    });
    expect(actions).toEqual([{ kind: "edit", messageId: first.id, text: edited.text }]);
    const confirmed = { ...initial, revision: 2, queuedMessages: [edited, second] };
    await act(async () => requests[0].resolve(confirmed));
    expect(actions.at(-1)).toEqual({ kind: "steer", messageId: first.id });
    expect(queue().messages[0]).toEqual(edited);
    await act(async () =>
      requests[1].resolve({
        ...confirmed,
        revision: 3,
        queuedMessages: [second],
        messages: [{ ...edited, role: "user" }],
      }),
    );
    expect(queue().messages).toEqual([second]);
    expect(queue().sending.size).toBe(0);
  });
});

test("a failed edit cancels only its dependent send while another queued item can proceed", async () => {
  await queueProbe(async ({ queue, initial, requests, actions, errors, recovered }) => {
    const [first, second] = initial.queuedMessages;
    await act(async () => {
      queue().change({ kind: "edit", messageId: first.id, text: "Corrected instruction" });
      queue().change({ kind: "steer", messageId: first.id });
      queue().change({ kind: "steer", messageId: second.id });
    });
    expect(queue().messages[0].text).toBe("Corrected instruction");
    await act(async () => requests[0].reject(new Error("Edit failed")));
    expect(errors).toHaveLength(1);
    expect(recovered).toEqual([{ ...first, text: "Corrected instruction" }]);
    expect(actions).toEqual([
      { kind: "edit", messageId: first.id, text: "Corrected instruction" },
      { kind: "steer", messageId: second.id },
    ]);
    expect([...queue().sending]).toEqual([second.id]);
    await act(async () =>
      requests[1].resolve({
        ...initial,
        revision: 2,
        queuedMessages: [first],
        messages: [{ ...second, role: "user" }],
      }),
    );
    expect(queue().messages).toEqual([first]);
    expect(queue().sending.size).toBe(0);
    await act(async () => queue().change({ kind: "steer", messageId: first.id }));
    expect(requests).toHaveLength(3);
    await act(async () => requests[2].resolve(initial));
  });
});

test("Stop remains immediate during an outstanding send and repeats after the pending request settles", async () => {
  await queueProbe(async ({ queue, initial, requests, stops }) => {
    const [first] = initial.queuedMessages;
    await act(async () => queue().change({ kind: "steer", messageId: first.id }));
    await act(async () => queue().stop());
    expect(stops()).toBe(1);
    expect(queue().stopping).toBe(true);
    await act(async () => requests[0].resolve(initial));
    expect(stops()).toBe(2);
    expect(queue().stopping).toBe(false);
    expect(queue().messages).toEqual(initial.queuedMessages);
  });
});
