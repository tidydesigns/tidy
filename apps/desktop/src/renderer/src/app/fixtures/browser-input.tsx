import { useRef } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import {
  emptyBrowserState,
  type BrowserAPI,
  type BrowserInput,
} from "../../../../shared/contracts/browser";
import { BrowserPage } from "../../features/browser/browser-page";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function runBrowserInputTests(root: Root) {
  const inputs: BrowserInput[] = [];
  const api: BrowserAPI = {
    discardDraft: async () => {},
    copy: async () => {},
    download: async () => {},
    command: async () => ({ state: emptyBrowserState }),
    watch: () => () => {},
    input: (_scope, envelope) => inputs.push(envelope.input),
  };
  const scope = { projectId: crypto.randomUUID(), threadId: crypto.randomUUID() };
  const tab = {
    id: crypto.randomUUID(),
    viewId: crypto.randomUUID(),
    url: "https://example.com/",
    title: "Input fixture",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    width: 800,
    height: 600,
  };
  function Fixture() {
    const canvas = useRef<HTMLCanvasElement>(null);
    const keyboard = useRef<HTMLTextAreaElement>(null);
    const addressInput = useRef<HTMLInputElement>(null);
    return (
      <div style={{ width: 400, height: 300, containerType: "size", position: "relative" }}>
        <BrowserPage
          api={api}
          scope={scope}
          tab={tab}
          interactive
          editingCommands={false}
          canvas={canvas}
          keyboard={keyboard}
          addressInput={addressInput}
          painted
          copy={async () => {}}
          setError={(message) => {
            throw new Error(message);
          }}
          send={(input) => inputs.push(input)}
        />
      </div>
    );
  }
  flushSync(() => root.render(<Fixture />));
  const host = document.getElementById("root")!;
  const canvas = host.querySelector("canvas")!;
  const keyboard = host.querySelector("textarea")!;
  let captured = false;
  Object.assign(canvas, {
    setPointerCapture: () => {
      captured = true;
    },
    hasPointerCapture: () => captured,
    releasePointerCapture: () => {
      captured = false;
    },
  });
  const bounds = canvas.getBoundingClientRect();
  check(bounds.width > 0, "Browser canvas has no dimensions");
  const pointer = (type: string, x: number, y: number, pointerType = "touch") =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType,
        isPrimary: true,
        clientX: bounds.left + x,
        clientY: bounds.top + y,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
      }),
    );
  const key = (type: string, key: string, keyCode: number) =>
    keyboard.dispatchEvent(
      new KeyboardEvent(type, { bubbles: true, cancelable: true, key, code: key, keyCode }),
    );
  const input = (inputType: string, value: string) => {
    keyboard.value = value;
    keyboard.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  };
  pointer("pointerdown", 100, 150);
  pointer("pointermove", 100, 100);
  pointer("pointerup", 100, 100);
  const wheel = inputs.at(0);
  check(inputs.length === 1 && wheel?.kind === "wheel", "Touch panning sent a drag or click");
  check(
    wheel.deltaY === (50 * tab.height) / bounds.height,
    "Touch panning used incorrect scale or direction",
  );
  check(document.activeElement !== keyboard, "Touch panning raised the keyboard");
  inputs.length = 0;
  pointer("pointerdown", 100, 100);
  pointer("pointermove", 102, 101);
  pointer("pointerup", 102, 101);
  check(
    inputs.length === 2 && [...inputs].every((input) => input.kind === "mouse"),
    "Touch tap did not produce one click",
  );
  check(document.activeElement === keyboard, "Touch tap lost page keyboard input");
  inputs.length = 0;
  pointer("pointerdown", 100, 100);
  pointer("pointercancel", 100, 100);
  pointer("pointerup", 100, 100);
  check(!inputs.some((input) => input.kind === "mouse"), "Cancelled touch became a click");

  inputs.length = 0;
  pointer("pointerdown", 100, 100, "mouse");
  canvas.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + 100,
      clientY: bounds.top + 100,
      button: 0,
      buttons: 1,
    }),
  );
  pointer("pointermove", 110, 110, "mouse");
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  pointer("pointerup", 110, 110, "mouse");
  canvas.dispatchEvent(
    new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + 110,
      clientY: bounds.top + 110,
      button: 0,
      buttons: 0,
    }),
  );
  check(
    inputs.length === 3 && [...inputs].every((input) => input.kind === "mouse"),
    "Mouse drag became touch scrolling",
  );
  check(
    inputs[1]?.kind === "mouse" && inputs[1].action === "move" && inputs[1].buttons === 1,
    "Mouse drag lost its held button",
  );

  for (const [name, type, code] of [
    ["Backspace", "deleteContentBackward", 8],
    ["Delete", "deleteContentForward", 46],
    ["Enter", "insertLineBreak", 13],
    ["Enter", "insertParagraph", 13],
  ] as const) {
    inputs.length = 0;
    key("keydown", "Unidentified", 0);
    input(type, name === "Enter" ? "\u200b\n" : "");
    key("keyup", "Unidentified", 0);
    check(
      inputs.length === 2 &&
        [...inputs].every((input) => input.kind === "key" && input.key === name),
      "Soft keyboard editing key was not forwarded once",
    );
    check(
      keyboard.value === "\u200b" && keyboard.selectionStart === 1,
      "Editing key lost the input sentinel",
    );
    inputs.length = 0;
    key("keydown", name, code);
    input(type, name === "Enter" ? "\u200b\n" : "");
    key("keyup", name, code);
    check(
      inputs.length === 2 &&
        [...inputs].every((input) => input.kind === "key" && input.key === name),
      "Keydown plus input duplicated editing key",
    );
    key("keydown", name, code);
    key("keyup", name, code);
    inputs.length = 0;
    input(type, name === "Enter" ? "\u200b\n" : "");
    check(
      inputs.length === 2 &&
        [...inputs].every((input) => input.kind === "key" && input.key === name),
      "A physical key cycle swallowed the next soft keyboard deletion",
    );
  }
  inputs.length = 0;
  input("insertText", "\u200bhello");
  check(
    inputs.length === 1 && inputs[0]?.kind === "text" && inputs[0].text === "hello",
    "Soft keyboard text leaked its sentinel",
  );
}
