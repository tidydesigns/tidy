import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const tmux = Bun.which("tmux");
test.skipIf(!tmux)(
  "real tmux supports mouse panes, scrolling, clipboard, resize and reattach",
  async () => {
    // node-pty's native read callbacks require Node/Electron, not Bun's event loop.
    const child = Bun.spawn(
      [
        "node",
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../../../../../scripts/terminal-tmux.fixture.ts", import.meta.url)),
        tmux!,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill(), 20000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({
        split: true,
        mouseSelect: true,
        mouseResize: true,
        mouseCopy: true,
        wheelCopyMode: true,
        clipboard: true,
        resize: true,
        reattach: true,
      });
    } finally {
      clearTimeout(timer);
    }
  },
  25_000,
);
