import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Ghostty } from "ghostty-web";
import { TerminalResponses, installTerminalResponses } from "./terminal-responses";
import { terminalWasm } from "./terminal-wasm";

const theme = { foreground: "#292929", background: "#ffffff" };
const da1 = "\x1b[?1;2c";
const da2 = "\x1b[>0;0;0c";
const foreground = "\x1b]10;rgb:2929/2929/2929\x1b\\";
const background = "\x1b]11;rgb:ffff/ffff/ffff\x1b\\";
const queries = ["\x1b[c", "\x1b[0c", "\x1b[>c", "\x1b[>0c", "\x1b]10;?\x07", "\x1b]11;?\x1b\\"];
const replies = [da1, da1, da2, da2, foreground, background];

test("capability and theme queries work across every PTY chunk boundary", () => {
  for (let index = 0; index < queries.length; index++) {
    const query = queries[index];
    for (let split = 0; split <= query.length; split++) {
      const parser = new TerminalResponses(theme);
      expect(parser.write(query.slice(0, split)) + parser.write(query.slice(split))).toBe(
        replies[index],
      );
    }
    const parser = new TerminalResponses(theme);
    expect(
      Array.from(new TextEncoder().encode(query), (byte) => parser.write(Uint8Array.of(byte))).join(
        "",
      ),
    ).toBe(replies[index]);
  }
  const parser = new TerminalResponses(theme);
  expect(parser.write(queries.join("ordinary text"))).toBe(replies.join(""));
});

test("payloads, cancelled and oversized sequences cannot generate terminal input", () => {
  for (const prefix of ["\x1b]52;", "\x1b]0;", "\x1bP", "\x1b_", "\x1b^", "\x1bX"]) {
    const parser = new TerminalResponses(theme);
    for (const char of `${prefix}\x1b[c\x1b[>c\x1b]11;?\x1b\\`) expect(parser.write(char)).toBe("");
    expect(parser.write("\x1b[c")).toBe(da1);
  }
  for (const cancel of ["\x18", "\x1a"]) {
    expect(new TerminalResponses(theme).write(`\x1b[${cancel}c`)).toBe("");
    expect(new TerminalResponses(theme).write(`\x1b]11;?${cancel}\x07`)).toBe("");
  }
  const parser = new TerminalResponses(theme);
  expect(parser.write(`\x1b[${"0".repeat(100_000)}c\x1b]${"x".repeat(100_000)}11;?\x07`)).toBe("");
  expect(parser.write("\x1b[c")).toBe(da1);
  expect(parser.write("\x1b[1c\x1b[?1;2c\x1b[>1c\x1b[5n\x1b[6n\x1b[?2026$p\x1b]52;?\x07")).toBe("");
});

test("reset discards partial queries and color replies use only valid configured colors", () => {
  const parser = new TerminalResponses(theme);
  parser.write("\x1b[");
  parser.reset();
  expect(parser.write("c")).toBe("");
  expect(new TerminalResponses({ background: "#171717" }).write("\x1b]11;?\x07")).toBe(
    "\x1b]11;rgb:1717/1717/1717\x1b\\",
  );
  for (const background of [undefined, "red", "#fff", "#ffffff\x1b[c"]) {
    expect(new TerminalResponses({ background }).write("\x1b]11;?\x07")).toBe("");
  }
});

test("ordinary UTF-8 output and C0 controls preserve split protocol state", () => {
  const parser = new TerminalResponses(theme);
  const bytes = new TextEncoder().encode("日本語🌻\x1b[c");
  expect(Array.from(bytes, (byte) => parser.write(Uint8Array.of(byte))).join("")).toBe(da1);
  expect(parser.write("\x1b[\x00\x07\x7fc")).toBe(da1);
  expect(parser.write("\x1b[1\x1b[c")).toBe(da1);
});

test("the pinned WASM needs these replies; its existing status responses remain single", async () => {
  const load = terminalWasm(
    async () =>
      Uint8Array.from(await readFile(new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm"))))
        .buffer,
  );
  const native = new Ghostty(await load()).createTerminal(80, 24);
  const output: string[] = [];
  const terminal = {
    options: { theme },
    write(data: string | Uint8Array, callback?: () => void) {
      native.write(data);
      const reply = native.readResponse();
      if (reply) output.push(reply);
      callback?.();
    },
    reset() {},
    input(data: string, userInput?: boolean) {
      expect(userInput).toBe(true);
      output.push(data);
    },
  };
  try {
    // Fail visibly on a dependency upgrade that would duplicate our replies.
    for (const query of queries) {
      native.write(query);
      expect(native.readResponse()).toBeNull();
    }
    installTerminalResponses(terminal);
    terminal.write("\x1b[c");
    terminal.write("\x1b[5n");
    terminal.write("\x1b[6n");
    expect(output).toEqual([da1, "\x1b[0n", "\x1b[1;1R"]);
    terminal.write("\x1b[");
    terminal.reset();
    terminal.write("c");
    expect(output).toHaveLength(3);
  } finally {
    native.free();
  }
});
