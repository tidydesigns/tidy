import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Ghostty } from "ghostty-web";
import { terminalWasm } from "./terminal-wasm";

async function bytes() {
  const buffer = await readFile(new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm")));
  return Uint8Array.from(buffer).buffer;
}

test("concurrent renderers share compilation but own separate terminal memory", async () => {
  let loads = 0;
  const load = terminalWasm(async () => {
    loads++;
    return bytes();
  });
  const [first, second] = await Promise.all([load(), load()]);
  expect(loads).toBe(1);
  expect(first.exports.memory).not.toBe(second.exports.memory);
  const a = new Ghostty(first).createTerminal(80, 24);
  const b = new Ghostty(second).createTerminal(80, 24);
  try {
    a.write("first");
    b.write("second");
    a.resize(120, 30);
    a.update();
    b.update();
    expect(a.getViewport()[0].codepoint).toBe("f".codePointAt(0)!);
    expect(b.getViewport()[0].codepoint).toBe("s".codePointAt(0)!);
    a.free();
    b.write(" intact");
    b.update();
    expect(
      String.fromCodePoint(
        ...b
          .getViewport()
          .slice(0, 13)
          .map((cell) => cell.codepoint),
      ),
    ).toBe("second intact");
  } finally {
    b.free();
  }
  const replacement = await load();
  expect(loads).toBe(1);
  expect(replacement.exports.memory).not.toBe(first.exports.memory);
});

test("a failed load can retry without poisoning the compiled runtime cache", async () => {
  let loads = 0;
  const load = terminalWasm(async () => {
    if (++loads === 1) throw new Error("Unavailable");
    return bytes();
  });
  const failed = await Promise.allSettled([load(), load()]);
  expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  await load();
  expect(loads).toBe(2);
});
