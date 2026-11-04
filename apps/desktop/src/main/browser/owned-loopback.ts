import type { ChildProcess } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { readLocalFile } from "../platform/local-files";

const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
type Endpoint = { port: number; peer: number; state: string; inode: string };

export class OwnedLoopback {
  private descriptor: number | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly child: ChildProcess) {
    if (!child.pid) throw new Error("The video process could not start.");
    this.descriptor = openSync(
      `/proc/${child.pid}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    child.once("exit", () => this.close());
  }

  private path() {
    if (
      this.descriptor === undefined ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      throw new Error("The video process disconnected.");
    return `/proc/self/fd/${this.descriptor}`;
  }

  private async endpoints() {
    const path = this.path();
    const entries = await readdir(`${path}/fd`);
    const descriptors = await Promise.all(
      entries.map((entry) => readlink(`${path}/fd/${entry}`).catch(() => "")),
    );
    const owned = new Set(descriptors);
    const table = (await readLocalFile(`${path}/net/tcp`, 4 * 1024 * 1024)).toString("utf8");
    this.path();
    const result: Endpoint[] = [];
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const local = fields[1]?.split(":"),
        peer = fields[2]?.split(":");
      if (
        local?.[0] !== "0100007F" ||
        !peer ||
        !["00000000", "0100007F"].includes(peer[0]) ||
        !owned.has(`socket:[${fields[9]}]`)
      )
        continue;
      result.push({
        port: Number.parseInt(local[1], 16),
        peer: Number.parseInt(peer[1], 16),
        state: fields[3],
        inode: fields[9],
      });
    }
    return result;
  }

  async port() {
    const deadline = Date.now() + 10000;
    do {
      const listeners = (await this.endpoints()).filter((entry) => entry.state === "0A");
      if (listeners.length === 1) return listeners[0].port;
      if (listeners.length > 1)
        throw new Error("The video process has ambiguous listening sockets.");
      await wait();
    } while (Date.now() < deadline);
    throw new Error("The video process did not open a private listener.");
  }

  async connect(port: number) {
    this.path();
    const socket = createConnection({ host: "127.0.0.1", port });
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
    socket.setTimeout(2000, () =>
      socket.destroy(new Error("Video connection verification timed out.")),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
        socket.once("close", () =>
          reject(new Error("Video connection closed before verification.")),
        );
      });
      const deadline = Date.now() + 1000;
      do {
        if (socket.destroyed) break;
        const peer = (await this.endpoints()).find(
          (entry) => entry.state === "01" && entry.port === port && entry.peer === socket.localPort,
        );
        if (peer && !socket.destroyed) {
          this.path();
          socket.setTimeout(0);
          return socket;
        }
        await wait();
      } while (Date.now() < deadline);
      throw new Error("Could not verify the video connection belongs to the managed process.");
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  close() {
    for (const socket of this.sockets) socket.destroy();
    if (this.descriptor !== undefined) closeSync(this.descriptor);
    this.descriptor = undefined;
  }
}
