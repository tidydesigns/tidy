import { execFile } from "node:child_process";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const retryDelays = [5_000, 15_000, 30_000];
const busyFailure = z.object({
  code: z.literal(1),
  stderr: z.string(),
  killed: z.literal(false).optional(),
  signal: z.null().optional(),
});

export async function createDiskImage(
  {
    sourceDirectory,
    outputPath,
    volumeName,
  }: { sourceDirectory: string; outputPath: string; volumeName: string },
  {
    run = (args: string[]) =>
      execute("/usr/bin/hdiutil", args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 180_000,
      }),
    wait = setTimeout,
  }: {
    run?: (args: string[]) => Promise<unknown>;
    wait?: (milliseconds: number) => Promise<unknown>;
  } = {},
) {
  const temporary = await mkdtemp(join(dirname(outputPath), ".tidy-dmg-"));
  try {
    for (let attempt = 0; ; attempt++) {
      const image = join(temporary, `attempt-${attempt + 1}.dmg`);
      try {
        await run([
          "create",
          "-volname",
          volumeName,
          "-srcfolder",
          sourceDirectory,
          "-format",
          "UDZO",
          image,
        ]);
      } catch (error) {
        const failure = busyFailure.safeParse(error).data;
        const delay = retryDelays[attempt];
        if (
          delay === undefined ||
          !failure ||
          !/^hdiutil: create failed - Resource busy\s*$/m.test(failure.stderr)
        )
          throw error;
        console.warn(
          `Disk image creation is busy; retrying in ${delay / 1_000}s (${attempt + 2}/${retryDelays.length + 1}).`,
        );
        await wait(delay);
        continue;
      }
      await run(["verify", image]);
      await rename(image, outputPath);
      return;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 1_000 });
  }
}
