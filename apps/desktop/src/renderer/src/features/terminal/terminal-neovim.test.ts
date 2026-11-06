import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const nvim = Bun.which("nvim");
test.skipIf(!nvim)(
  "real Neovim exits without waiting for its one-second DA1 timeout",
  async () => {
    // node-pty's native read callbacks require Node/Electron, not Bun's event loop.
    const child = Bun.spawn(
      [
        "node",
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(
          new URL("../../../../../scripts/terminal-neovim.fixture.ts", import.meta.url),
        ),
        nvim!,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill(), 8000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout).exitScreenMs).toBeLessThan(750);
    } finally {
      clearTimeout(timer);
    }
  },
  10_000,
);
