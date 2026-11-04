import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { OwnedLoopback } from "./owned-loopback";

const enabled = process.platform === "linux" && !process.versions.bun;

test(
  "video transport authenticates only to the exact managed peer, never a replacement listener",
  { skip: !enabled, timeout: 15000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { createServer } from 'node:net';
    createServer(socket => socket.on('data', data => socket.write(data))).listen(0, '127.0.0.1');
  `,
      ],
      { stdio: "ignore" },
    );
    const owner = new OwnedLoopback(child);
    let leaked = 0;
    const rejectedSockets = new Set<import("node:net").Socket>();
    const impostor = createServer((socket) => {
      rejectedSockets.add(socket);
      socket.on("data", (data) => {
        leaked += data.length;
      });
      socket.once("close", () => rejectedSockets.delete(socket));
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    try {
      const port = await owner.port();
      const socket = await owner.connect(port);
      const reply = once(socket, "data");
      socket.write("fixture-authorization");
      const [data] = await reply;
      assert.equal(String(data), "fixture-authorization");
      socket.destroy();
      const address = impostor.address();
      assert.ok(address && typeof address !== "string");
      await assert.rejects(owner.connect(address.port), /verify|verification/);
      assert.equal(leaked, 0, "An unverified listener receives no application bytes.");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await assert.rejects(owner.connect(port), /disconnected/);
    } finally {
      owner.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      for (const socket of rejectedSockets) socket.destroy();
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
  },
);
