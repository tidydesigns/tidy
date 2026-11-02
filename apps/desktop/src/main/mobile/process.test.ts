import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { executable } from "./discovery";
import { mobileExec } from "./process";

test.skipIf(process.platform === "win32")(
  "a child closing stdin reports a pipe failure without crashing the Node host",
  async () => {
    const node = await executable("node");
    if (!node) throw new Error("Node is required for the process regression test");
    const loader = await realpath(
      join(import.meta.dir, "../../../node_modules/tsx/dist/loader.mjs"),
    );
    const module = pathToFileURL(join(import.meta.dir, "process.ts")).href;
    const output = await mobileExec(
      node,
      [
        "--import",
        loader,
        "--input-type=module",
        "--eval",
        `
    import { mobileProcess } from ${JSON.stringify(module)};
    const child = mobileProcess(process.execPath, ["-e", "require('node:fs').closeSync(0); console.log('ready'); setInterval(() => {}, 1000)"]);
    await new Promise(resolve => child.process.stdout.once('data', resolve));
    child.process.stdin.write(Buffer.alloc(128 * 1024));
    try {
      await child.done;
      throw new Error('Expected the closed pipe to reject');
    } catch (error) {
      if (error.code !== 'EPIPE') throw error;
    }
    console.log('Handled broken stdin');
  `,
      ],
      { timeout: 10_000 },
    );
    expect(output).toContain("Handled broken stdin");
  },
  15_000,
);
