import { afterEach, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVideoChunk } from "../workspace/video-preview";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.skipIf(!["linux", "darwin"].includes(process.platform))(
  "an ancestor replaced only during open cannot expose outside bytes",
  async () => {
    const directory = await filesystem.mkdtemp(join(tmpdir(), "video-path-race-"));
    cleanups.push(() => filesystem.rm(directory, { recursive: true, force: true }));
    const root = join(await filesystem.realpath(directory), "project");
    const recordings = join(root, "recordings");
    const outside = join(directory, "outside");
    await filesystem.mkdir(recordings, { recursive: true });
    await filesystem.mkdir(outside);
    await filesystem.writeFile(join(recordings, "demo.mp4"), "project recording");
    await filesystem.writeFile(join(outside, "demo.mp4"), "private recording");
    const originalOpen = filesystem.open;
    let swapped = false;
    const open = spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
      const target =
        typeof path === "string" &&
        (process.platform === "linux"
          ? path.startsWith("/proc/self/fd/") && path.endsWith("/recordings")
          : path === join(recordings, "demo.mp4"));
      if (!target || swapped) return originalOpen(path, flags, mode);
      swapped = true;
      await filesystem.rename(recordings, `${recordings}-original`);
      await filesystem.symlink(outside, recordings);
      try {
        return await originalOpen(path, flags, mode);
      } finally {
        await filesystem.unlink(recordings);
        await filesystem.rename(`${recordings}-original`, recordings);
      }
    });
    cleanups.push(() => open.mockRestore());
    await expect(
      readVideoChunk({ root, href: "recordings/demo.mp4", offset: 0 }),
    ).rejects.toThrow();
    expect(swapped).toBe(true);
    open.mockRestore();
    const result = await readVideoChunk({ root, href: "recordings/demo.mp4", offset: 0 });
    expect(Buffer.from(result.data, "base64").toString()).toBe("project recording");
  },
);
