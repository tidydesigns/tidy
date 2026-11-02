import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMobileApp, reloadMetro } from "./runner";

test("Expo keeps Metro watching, reuses its port for the native build, and reloads without rebuilding", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-expo-run-"));
  const controller = new AbortController();
  let app: Awaited<ReturnType<typeof runMobileApp>> | undefined;
  try {
    const expo = join(root, "node_modules/expo");
    await mkdir(join(expo, "bin"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(expo, "package.json"), '{"name":"expo","version":"58.0.0"}');
    await writeFile(
      join(expo, "bin/cli"),
      `
      const http = require("node:http"), fs = require("node:fs");
      const args = process.argv.slice(2);
      const port = args[0] === "start" ? Number(args[args.indexOf("--port") + 1]) : Number(new URL(process.env.EXPO_PACKAGER_PROXY_URL).port);
      if (args[0] === "start") {
        if (process.env.CI !== "false") throw Error("File watching disabled by CI");
        const server = http.createServer((req, res) => {
          if (req.url === "/reload") fs.writeFileSync("reloaded", "yes");
          res.end("packager-status:running");
        }).listen(port, "127.0.0.1");
        const { WebSocketServer } = require(${JSON.stringify(await realpath(join(import.meta.dir, "../../../node_modules/ws")))});
        const wss = new WebSocketServer({ server, path: "/message" });
        wss.on("connection", socket => socket.on("message", data => {
          const message = JSON.parse(data.toString());
          if (message.version === 2 && message.method === "reload") {
            if (fs.existsSync("unrelated")) {
              socket.send(JSON.stringify({ version: 2, method: "devMenu" }));
              fs.writeFileSync("ignored-reload", "yes");
            } else {
              fs.writeFileSync("reloaded", "yes");
              socket.send(data.toString());
            }
          }
        }));
        fs.writeFileSync("metro-port", String(port));
      } else {
        if (!args.includes("--no-bundler") || args.includes("--port")) throw Error("Expected one existing Metro server");
        if (new URL(process.env.EXPO_PACKAGER_PROXY_URL).hostname !== "127.0.0.1") throw Error("Preview must stay on loopback");
        if (String(port) !== fs.readFileSync("metro-port", "utf8")) throw Error("Different Metro port");
        fs.appendFileSync("builds", "build\\n");
      }
    `,
    );
    let running = 0;
    app = await runMobileApp({
      root,
      target: {
        id: "expo:.",
        name: "Expo",
        directory: ".",
        kind: "expo",
        platforms: ["ios", "android"],
      },
      device: {
        id: "simulator",
        name: "iPhone",
        platform: "ios",
        runtime: "iOS",
        state: "running",
      },
      serial: "test-simulator",
      signal: controller.signal,
      output() {},
      stage() {},
      running() {
        running++;
      },
      failed(error) {
        throw error;
      },
    });
    expect(running).toBe(1);
    await app.reload();
    expect(await readFile(join(root, "reloaded"), "utf8")).toBe("yes");
    expect((await readFile(join(root, "builds"), "utf8")).trim().split("\n")).toHaveLength(1);
    await writeFile(join(root, "unrelated"), "yes");
    const cancelled = new AbortController();
    try {
      const port = Number(await readFile(join(root, "metro-port"), "utf8"));
      const result = reloadMetro(port, cancelled.signal).then(
        () => null,
        (error: unknown) => error,
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await readFile(join(root, "ignored-reload"), "utf8").catch(() => null)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await readFile(join(root, "ignored-reload"), "utf8")).toBe("yes");
      cancelled.abort();
      expect(await result).toMatchObject({ message: "App run stopped." });
    } finally {
      cancelled.abort();
    }
  } finally {
    await app?.stop();
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform === "win32")(
  "Flutter clean exit ends the run and Reload rejects the closed pipe",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tidy-flutter-exit-"));
    const previousPath = process.env.PATH;
    const controller = new AbortController();
    let app: Awaited<ReturnType<typeof runMobileApp>> | undefined;
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const flutter = join(bin, "flutter");
      await writeFile(
        flutter,
        "#!/usr/bin/env node\nconsole.log('Flutter run key commands'); setTimeout(() => process.exit(0), 50);\n",
      );
      await chmod(flutter, 0o755);
      process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
      const failed = Promise.withResolvers<unknown>();
      app = await runMobileApp({
        root,
        target: {
          id: "flutter:.",
          name: "Flutter",
          directory: ".",
          kind: "flutter",
          platforms: ["ios", "android"],
        },
        device: {
          id: "simulator",
          name: "iPhone",
          platform: "ios",
          runtime: "iOS",
          state: "running",
        },
        serial: "test-simulator",
        signal: controller.signal,
        output() {},
        stage() {},
        running() {},
        failed: failed.resolve,
      });
      expect(await failed.promise).toMatchObject({
        message: "Flutter stopped. Run the app again.",
      });
      await expect(app.reload()).rejects.toThrow("Flutter stopped");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await app?.stop();
      controller.abort();
      await rm(root, { recursive: true, force: true });
    }
  },
);
