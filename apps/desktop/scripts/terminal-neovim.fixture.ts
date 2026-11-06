import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "@lydell/node-pty";
import { Ghostty } from "ghostty-web";
import { installTerminalResponses } from "../src/renderer/src/features/terminal/terminal-responses";
import { terminalWasm } from "../src/renderer/src/features/terminal/terminal-wasm";

const nvim = process.argv[2];
async function check() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-neovim-"));
  const load = terminalWasm(
    async () =>
      Uint8Array.from(await readFile(new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm"))))
        .buffer,
  );
  const native = new Ghostty(await load()).createTerminal(80, 24);
  const pty = spawn(nvim!, ["--clean", "-i", "NONE"], {
    cwd: directory,
    cols: 80,
    rows: 24,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: directory,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "Tidy",
    },
  });
  const terminal = {
    options: { theme: { background: "#171717", foreground: "#ededed" } },
    write(data: string | Uint8Array) {
      native.write(data);
      const reply = native.readResponse();
      if (reply) pty.write(reply);
    },
    reset() {},
    input(data: string) {
      pty.write(data);
    },
  };
  installTerminalResponses(terminal);
  let exited = false;
  let ready = false;
  let quitAt = 0;
  let restoredAt = 0;
  let output = "";
  let quitTimer: ReturnType<typeof setTimeout> | undefined;
  const finished = Promise.withResolvers<number>();
  const timeout = setTimeout(
    () =>
      finished.reject(
        new Error(
          `Neovim fixture timed out: ready=${ready}, quit=${quitAt}, output=${JSON.stringify(output.slice(-300))}`,
        ),
      ),
    6000,
  );
  const dataSubscription = pty.onData((data) => {
    output = (output + data).slice(-8192);
    terminal.write(data);
    if (!ready && output.includes("\x1b[?1049h")) {
      ready = true;
      // Keep startup out of the exit measurement. No user's config/plugins are loaded.
      quitTimer = setTimeout(() => {
        quitAt = performance.now();
        pty.write(":q\r");
      }, 300);
    }
    if (quitAt && !restoredAt && output.includes("\x1b[?1049l")) restoredAt = performance.now();
  });
  const exitSubscription = pty.onExit(({ exitCode }) => {
    exited = true;
    finished.resolve(exitCode);
  });
  try {
    assert.equal(await finished.promise, 0);
    assert.equal(ready, true);
    assert.ok(restoredAt > quitAt);
    // Broad enough for CI scheduling, but fails the reproducible 1000 ms regression.
    assert.ok(restoredAt - quitAt < 750, `Neovim exit took ${restoredAt - quitAt}ms`);
    console.log(JSON.stringify({ exitScreenMs: restoredAt - quitAt }));
  } finally {
    clearTimeout(timeout);
    clearTimeout(quitTimer);
    dataSubscription.dispose();
    exitSubscription.dispose();
    if (!exited) pty.kill();
    native.free();
    await rm(directory, { recursive: true, force: true });
  }
}
await check();
