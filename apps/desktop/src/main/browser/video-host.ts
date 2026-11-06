import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import type { Page } from "puppeteer-core";
import { OwnedLoopback } from "./owned-loopback";

const geometrySchema = z.object({
  t: z.literal("hello"),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}

export class BrowserVideoHost {
  display = "";
  private readonly children = new Set<ChildProcess>();
  private starting?: Promise<{ port: number; password: string; owner: OwnedLoopback }>;
  private owner?: OwnedLoopback;
  private closed = false;
  private control?: WebSocket;
  private width = 0;
  private height = 0;
  private xauthority = "";

  get environment() {
    return { DISPLAY: this.display, XAUTHORITY: this.xauthority };
  }

  async start(directory: string) {
    if (process.platform !== "linux")
      throw new Error("Video streaming currently requires a Linux browser host.");
    this.xauthority = join(directory, "Xauthority");
    const field = (value: Buffer) => {
      const size = Buffer.alloc(2);
      size.writeUInt16BE(value.length);
      return Buffer.concat([size, value]);
    };
    await writeFile(
      this.xauthority,
      Buffer.concat([
        Buffer.from([255, 255]),
        field(Buffer.alloc(0)),
        field(Buffer.alloc(0)),
        field(Buffer.from("MIT-MAGIC-COOKIE-1")),
        field(randomBytes(16)),
      ]),
      { mode: 0o600 },
    );
    const child = this.spawn(
      process.env.TIDY_XVFB_EXECUTABLE ?? "Xvfb",
      [
        "-displayfd",
        "3",
        "-screen",
        "0",
        "2560x1600x24",
        "-nolisten",
        "tcp",
        "-auth",
        this.xauthority,
        "-noreset",
      ],
      { TMPDIR: directory },
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("Virtual browser display did not start.")),
        10000,
      );
      let text = "";
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        child.removeListener("exit", exited);
        child.removeListener("error", finish);
        if (error) reject(error);
        else resolve();
      };
      const exited = () => finish(new Error("Virtual browser display exited before startup."));
      child.once("exit", exited);
      child.once("error", finish);
      child.stdio[3]?.on("data", (data: Buffer) => {
        text += data.toString();
        if (/^\d+\n$/.test(text)) {
          this.display = `:${text.trim()}`;
          finish();
        }
      });
    });
    const manager = this.spawn(process.env.TIDY_BROWSER_WINDOW_MANAGER_EXECUTABLE ?? "openbox", [
      "--sm-disable",
    ]);
    await new Promise<void>((resolve, reject) => {
      manager.once("spawn", resolve);
      manager.once("error", reject);
    });
  }

  private spawn(executable: string, args: string[], env: NodeJS.ProcessEnv = {}, output = false) {
    if (this.closed) throw new Error("Browser video host is closed.");
    const child = spawn(executable, args, {
      env: { ...process.env, ...this.environment, ...env },
      stdio: ["ignore", output ? "pipe" : "ignore", "pipe", "pipe"],
    });
    this.children.add(child);
    child.stderr?.resume();
    child.on("error", () => {});
    child.once("close", () => {
      this.children.delete(child);
    });
    return child;
  }

  private displayCommand(args: string[]) {
    const child = this.spawn(process.env.TIDY_XRANDR_EXECUTABLE ?? "xrandr", args, {}, true);
    return new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Virtual display reset timed out."));
      }, 5000);
      child.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
        if (output.length > 64 * 1024) child.kill("SIGKILL");
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve(output);
        else reject(new Error("Could not reset the virtual browser display."));
      });
    });
  }

  private ensure() {
    if (this.closed) return Promise.reject(new Error("Browser video host is closed."));
    if (!this.starting) {
      const starting = this.startServer().catch((error: unknown) => {
        if (this.starting === starting) this.starting = undefined;
        throw error;
      });
      this.starting = starting;
    }
    return this.starting;
  }

  private async startServer() {
    await this.displayCommand(["--fb", "2560x1600", "--output", "screen", "--mode", "2560x1600"]);
    const modes = await this.displayCommand(["--query"]);
    for (const match of modes.matchAll(/^\s+(voxl-\d+x\d+)\s/gm)) {
      await this.displayCommand(["--delmode", "screen", match[1]]);
      await this.displayCommand(["--rmmode", match[1]]);
    }
    if (this.closed) throw new Error("Browser video host is closed.");
    const password = randomBytes(32).toString("hex");
    const child = this.spawn(
      process.env.TIDY_VOXL_EXECUTABLE ?? "voxl",
      [
        "--addr=127.0.0.1",
        "--port=0",
        "--audio-enabled=false",
        "--microphone-enabled=false",
        "--enable-clipboard=false",
        "--file-transfers=none",
        "--enable-resize=true",
        "--resize-scale=1",
        "--stripes=1",
        "--framerate=60",
        "--max-kbps=12000",
      ],
      { VOXL_PASSWORD: password },
    );
    let owner: OwnedLoopback | undefined;
    try {
      owner = new OwnedLoopback(child);
      this.owner = owner;
      child.once("exit", () => {
        if (this.owner !== owner) return;
        this.starting = undefined;
        this.owner = undefined;
        this.control?.terminate();
        this.control = undefined;
      });
      const port = await owner.port();
      if (this.closed) throw new Error("Browser video host is closed.");
      return { port, password, owner };
    } catch (error) {
      owner?.close();
      await stop(child);
      throw error;
    }
  }

  async connect() {
    const server = await this.ensure();
    if (this.closed) throw new Error("Browser video host is closed.");
    const socket = await server.owner.connect(server.port);
    if (this.closed || this.owner !== server.owner) {
      socket.destroy();
      throw new Error("The video process disconnected.");
    }
    return new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Authorization: `Bearer ${server.password}` },
      createConnection: () => socket,
      followRedirects: false,
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false,
      handshakeTimeout: 5000,
    });
  }

  async prepare(page: Page, width: number, height: number) {
    const w = Math.max(640, Math.ceil(width / 8) * 8),
      h = Math.max(480, Math.ceil(height / 2) * 2);
    if (!this.control || this.control.readyState !== WebSocket.OPEN) {
      const socket = await this.connect();
      this.control = socket;
      this.width = this.height = 0;
      socket.on("error", () => {});
      socket.on("message", (data, binary) => {
        if (binary) return;
        try {
          const message: unknown = JSON.parse(data.toString());
          const geometry = geometrySchema.safeParse(message);
          if (geometry.success) {
            this.width = geometry.data.w;
            this.height = geometry.data.h;
          }
          const ping = z.object({ t: z.literal("ping"), s: z.number() }).safeParse(message);
          if (ping.success && socket.readyState === WebSocket.OPEN)
            socket.send(`po,${ping.data.s}`);
        } catch {}
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("Video control disconnected.")));
      });
    }
    const socket = this.control;
    socket.send(`sz,${w},${h}`);
    const deadline = Date.now() + 5000;
    while (
      (this.width !== w || this.height !== h) &&
      socket.readyState === WebSocket.OPEN &&
      Date.now() < deadline
    )
      await wait(10);
    if (this.width !== w || this.height !== h)
      throw new Error("Browser video resize did not complete.");
    const session = await page.createCDPSession();
    try {
      await page.bringToFront();
      const { windowId, bounds } = await session.send("Browser.getWindowForTarget");
      if (bounds.windowState !== "fullscreen" || bounds.width !== w || bounds.height !== h) {
        if (bounds.windowState === "fullscreen")
          await session.send("Browser.setWindowBounds", {
            windowId,
            bounds: { windowState: "normal" },
          });
        await session.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "fullscreen" },
        });
      }
      const readyBy = Date.now() + 5000;
      while (!this.closed) {
        const { bounds } = await session.send("Browser.getWindowBounds", { windowId });
        if (bounds.windowState === "fullscreen" && bounds.width === w && bounds.height === h) break;
        if (Date.now() >= readyBy)
          throw new Error(
            "Browser window did not match the video display. Check the host window manager.",
          );
        await wait(10);
      }
    } finally {
      await session.detach();
    }
  }

  async close() {
    this.closed = true;
    this.control?.terminate();
    this.owner?.close();
    await Promise.all([...this.children].map(stop));
    await this.starting?.catch(() => {});
  }
}
