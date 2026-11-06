import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { harnessEnvironment } from "./harnesses";

const execute = promisify(execFile);
const cache = new Map<string, { stamp: string; supported: Promise<boolean> }>();
const paramsSchema = z.object({
  properties: z.object({
    creditId: z.object({ type: z.union([z.literal("string"), z.array(z.string())]) }),
    idempotencyKey: z.object({ type: z.literal("string") }),
  }),
});

/** Older CLIs can silently discard creditId and let the service choose a different reset. */
export async function supportsExactReset(executable: string) {
  const info = await stat(executable);
  const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const cached = cache.get(executable);
  if (cached?.stamp === stamp) return cached.supported;
  const supported = (async () => {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "tidy-codex-schema-"));
      await execute(executable, ["app-server", "generate-json-schema", "--out", directory], {
        env: harnessEnvironment("codex"),
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const schema = paramsSchema.safeParse(
        JSON.parse(
          await readFile(
            join(directory, "v2/ConsumeAccountRateLimitResetCreditParams.json"),
            "utf8",
          ),
        ),
      );
      return schema.success && schema.data.properties.creditId.type.includes("string");
    } catch {
      // A refresh can recover from a transient timeout or filesystem failure.
      if (cache.get(executable)?.stamp === stamp) cache.delete(executable);
      return false;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  })();
  cache.set(executable, { stamp, supported });
  return supported;
}
