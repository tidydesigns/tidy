import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { QueueAction } from "../../../../shared/contracts/message-queue";
import { MessageQueue } from "./message-queue";

test("queue actions skip busy neighbors when restoring focus and busy items cannot be dragged", async () => {
  const window = new Window();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const messages = Array.from({ length: 4 }, (_, index) => ({
    id: crypto.randomUUID(),
    text: `Instruction ${index + 1}`,
  }));
  const actions: QueueAction[] = [];
  const render = (sending: Set<string>) =>
    act(async () =>
      root.render(
        createElement(
          "div",
          { className: "composer" },
          createElement(MessageQueue, {
            messages,
            running: true,
            sending,
            onChange: (action) => actions.push(action),
            onRecover: () => {},
          }),
          createElement("div", { contentEditable: true, "aria-label": "Message composer" }),
        ),
      ),
    );
  function button(label: string) {
    const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    if (!button) throw new Error(`Missing ${label}`);
    return button;
  }
  try {
    await render(new Set([messages[1].id, messages[2].id]));
    await act(async () => button("Expand queued messages (4)").click());
    expect(button("Reorder queued message 2").disabled).toBe(true);
    expect(button("Reorder queued message 2").getAttribute("draggable")).toBe("false");
    await act(async () =>
      button("Reorder queued message 1").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(actions).toEqual([{ kind: "move", messageId: messages[0].id, beforeId: null }]);
    actions.length = 0;
    await act(async () => button("Remove queued message 1").click());
    expect(document.activeElement).toBe(button("Edit queued message 4"));
    expect(actions).toEqual([{ kind: "remove", messageId: messages[0].id }]);
    await render(new Set(messages.slice(0, 3).map((message) => message.id)));
    await act(async () => button("Send queued message 4 now").click());
    expect(document.activeElement).toBe(host.querySelector('[contenteditable="true"]'));
    expect(actions.at(-1)).toEqual({ kind: "steer", messageId: messages[3].id });
    await render(new Set());
    actions.length = 0;
    await act(async () => button("Reorder queued message 2").click());
    await act(async () => button("Reorder queued message 4").click());
    expect(actions).toEqual([{ kind: "move", messageId: messages[1].id, beforeId: null }]);
    await act(async () => button("Reorder queued message 4").click());
    await act(async () => button("Reorder queued message 2").click());
    expect(actions.at(-1)).toEqual({
      kind: "move",
      messageId: messages[3].id,
      beforeId: messages[1].id,
    });
    await act(async () =>
      button("Reorder queued message 3").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      ),
    );
    expect(actions.at(-1)).toEqual({
      kind: "move",
      messageId: messages[2].id,
      beforeId: messages[1].id,
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
