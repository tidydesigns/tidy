import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { spawn } from "@lydell/node-pty";
import { Ghostty, type Terminal } from "ghostty-web";
import { Window } from "happy-dom";
import {
  installTerminalResponses,
  TerminalResponses,
} from "../src/renderer/src/features/terminal/terminal-responses";
import { installTerminalMouse } from "../src/renderer/src/features/terminal/terminal-mouse";
import { terminalWasm } from "../src/renderer/src/features/terminal/terminal-wasm";

const tmux = process.argv[2]!;
const directory = await mkdtemp(join(tmpdir(), "tidy-tmux-"));
// Keep socket paths short on macOS and isolate every test from the user's tmux server.
const socket = join(directory, "sock");
const config = join(directory, "tmux.conf");
await writeFile(config, "set -g mouse on\nset -g default-shell /bin/sh\nset -g status off\n");
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: directory,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TERM_PROGRAM: "Tidy",
  SHELL: "/bin/sh",
};
const command = (...args: string[]) =>
  execFileSync(tmux, ["-S", socket, ...args], {
    env,
    encoding: "utf8",
    timeout: 2000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const wait = async (check: () => boolean, description: string) => {
  const deadline = performance.now() + 4000;
  while (!check()) {
    assert.ok(performance.now() < deadline, `Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const load = terminalWasm(
  async () =>
    Uint8Array.from(await readFile(new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm"))))
      .buffer,
);
const native = new Ghostty(await load()).createTerminal(100, 30);
const window = new Window();
const element = window.document.createElement("div");
const canvas = window.document.createElement("canvas");
element.append(canvas);
window.document.body.append(element);
let wheel: ((event: WheelEvent) => boolean) | undefined;
let pty = spawn(tmux, ["-S", socket, "-f", config, "new-session", "-s", "test", "/bin/sh"], {
  cwd: directory,
  env,
  cols: 100,
  rows: 30,
});
let exited = false;
const copied: string[] = [];
const clipboard = new TerminalResponses({}, (text) => copied.push(text));
const terminal = {
  cols: 100,
  rows: 30,
  viewportY: 0,
  options: { theme: { background: "#171717", foreground: "#ededed" } },
  wasmTerm: native,
  renderer: { getCanvas: () => canvas },
  input(data: string) {
    pty.write(data);
  },
  write(data: string | Uint8Array) {
    native.write(data);
    const reply = native.readResponse();
    if (reply) pty.write(reply);
    clipboard.write(data);
  },
  reset() {},
  open(_element: HTMLElement) {
    void _element;
  },
  dispose() {},
  focus() {},
  clearSelection() {},
  scrollToLine() {},
  attachCustomWheelEventHandler(handler?: typeof wheel) {
    wheel = handler;
  },
};
canvas.getBoundingClientRect = () =>
  new window.DOMRect(0, 0, terminal.cols * 10, terminal.rows * 20);
installTerminalResponses(terminal);
installTerminalMouse(terminal as unknown as Terminal);
terminal.open(element as unknown as HTMLElement);
let data = pty.onData((chunk) => terminal.write(chunk));
let exit = pty.onExit(() => {
  exited = true;
});
const mouse = (type: string, x: number, y: number) =>
  canvas.dispatchEvent(
    new window.MouseEvent(type, {
      bubbles: true,
      clientX: (x - 0.5) * 10,
      clientY: (y - 0.5) * 20,
      button: 0,
    }),
  );
try {
  await wait(() => native.hasMouseTracking() && native.getMode(1006, false), "tmux SGR mouse mode");
  terminal.input("\x02%");
  await wait(() => command("list-panes").split("\n").length === 2, "keyboard split");
  mouse("mousedown", 5, 5);
  mouse("mouseup", 5, 5);
  await wait(
    () => command("display-message", "-p", "#{pane_index}") === "0",
    "mouse selects left pane",
  );
  const before = Number(command("display-message", "-p", "#{pane_width}"));
  mouse("mousedown", before + 1, 10);
  mouse("mousemove", before + 10, 10);
  mouse("mouseup", before + 10, 10);
  await wait(
    () => Number(command("display-message", "-p", "#{pane_width}")) !== before,
    "mouse resizes divider",
  );
  command(
    "send-keys",
    "-t",
    "test:0.0",
    "i=0; while [ $i -lt 100 ]; do echo TMUX-LINE-$i; i=$((i+1)); done",
    "Enter",
  );
  await wait(
    () => command("capture-pane", "-p", "-t", "test:0.0").includes("TMUX-LINE-99"),
    "history output",
  );
  assert.equal(
    wheel?.({ deltaMode: 1, deltaY: -3, clientX: 50, clientY: 100 } as WheelEvent),
    true,
  );
  await wait(
    () => command("display-message", "-p", "-t", "test:0.0", "#{pane_in_mode}") === "1",
    "wheel enters tmux copy mode",
  );
  command("send-keys", "-t", "test:0.0", "-X", "cancel");
  command("send-keys", "-t", "test:0.0", "printf '\\033[2J\\033[HSELECT_ME\\n'", "Enter");
  await wait(
    () => command("capture-pane", "-p", "-t", "test:0.0").startsWith("SELECT_ME"),
    "copy selection text",
  );
  mouse("mousedown", 1, 1);
  mouse("mousemove", 10, 1);
  mouse("mouseup", 10, 1);
  await wait(
    () => copied.some((text) => text.trim() === "SELECT_ME"),
    "mouse selection copies through OSC 52",
  );
  // Exercise tmux's real OSC 52 output rather than fabricating its escape sequence.
  const value = "tmux clipboard 日本語 🌻";
  execFileSync(tmux, ["-S", socket, "load-buffer", "-w", "-"], {
    env,
    input: value,
    timeout: 2000,
  });
  await wait(() => copied.includes(value), "tmux clipboard write");
  native.resize(80, 24);
  terminal.cols = 80;
  terminal.rows = 24;
  pty.resize(80, 24);
  await wait(
    () => command("display-message", "-p", "#{window_width}x#{window_height}") === "80x24",
    "PTY resize",
  );
  terminal.input("\x02d");
  await wait(() => exited, "detach exits client");
  assert.equal(command("display-message", "-p", "#{session_attached}"), "0");
  data.dispose();
  exit.dispose();
  exited = false;
  pty = spawn(tmux, ["-S", socket, "attach", "-t", "test"], {
    cwd: directory,
    env,
    cols: 80,
    rows: 24,
  });
  data = pty.onData((chunk) => terminal.write(chunk));
  exit = pty.onExit(() => {
    exited = true;
  });
  await wait(() => command("display-message", "-p", "#{session_attached}") === "1", "reattach");
  assert.equal(command("list-panes").split("\n").length, 2);
  console.log(
    JSON.stringify({
      split: true,
      mouseSelect: true,
      mouseResize: true,
      mouseCopy: true,
      wheelCopyMode: true,
      clipboard: true,
      resize: true,
      reattach: true,
    }),
  );
} finally {
  data.dispose();
  exit.dispose();
  terminal.dispose();
  if (!exited) pty.kill();
  try {
    command("kill-server");
  } catch {
    /* Server may already have exited. */
  }
  native.free();
  await rm(directory, { recursive: true, force: true });
}
