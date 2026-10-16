import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer, CODEX_VERSION } from "./app-server";

test("malformed native RPC frames reject pending calls and stop the process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-rpc-test-"));
  const executable = join(directory, "runtime.ts");
  // Replace the external Codex binary, while exercising the real subprocess transport.
  await writeFile(
    executable,
    `#!${process.execPath}
    import { createInterface } from "node:readline";
    if (process.argv.includes("--version")) { console.log("codex-cli ${CODEX_VERSION}"); process.exit(); }
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      const input: { id?: number; method?: string } = JSON.parse(line);
      if (input.method === "initialize") console.log(JSON.stringify({ id: input.id, result: {} }));
      if (input.method === "account/read") console.log("null");
    }
  `,
  );
  await chmod(executable, 0o700);
  const runtime = new CodexAppServer(join(directory, "account"), executable);
  try {
    await runtime.start();
    await expect(runtime.request("account/read")).rejects.toThrow("Invalid Codex protocol message");
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
