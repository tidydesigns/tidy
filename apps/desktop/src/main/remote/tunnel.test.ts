import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { preparedHostSchema } from "../../shared/remote";
import { SshSession } from "./ssh";
import { openTunnel } from "./tunnel";

class LocalSession extends SshSession {
  child?: ReturnType<typeof spawn>;
  stopped?: Promise<unknown>;
  override launch() {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "pipe" });
    this.child = child;
    this.stopped = once(child, "close");
    return child;
  }
}

for (const outcome of ["ready", "cancelled", "closed"] as const) {
  test(`tunnel health cannot publish a stale connection: ${outcome}`, async () => {
    const session = new LocalSession({
      target: "fixture",
      temporaryDirectory: "unused",
      prompt: async () => null,
    });
    const host = preparedHostSchema.parse({
      protocol: 3,
      hostId: randomUUID(),
      instanceId: randomUUID(),
      buildId: "fixture",
      pid: process.pid,
      port: 1234,
      managed: false,
      clientId: randomUUID(),
      token: "a".repeat(64),
    });
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const originalFetch = globalThis.fetch;
    const fetching = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          entered.resolve();
          await release.promise;
          return Response.json({ ...host, activeRuns: 0 });
        },
        { preconnect: originalFetch.preconnect },
      ),
    );
    const controller = new AbortController();
    const pending = openTunnel({ ssh: session, host, signal: controller.signal });
    try {
      await entered.promise;
      if (outcome === "cancelled") controller.abort(new Error("Connection replaced"));
      if (outcome === "closed") {
        session.child?.kill();
        await session.stopped;
      }
      release.resolve();
      if (outcome === "ready") {
        const tunnel = await pending;
        expect(tunnel.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        tunnel.close();
      } else {
        await expect(pending).rejects.toThrow(
          outcome === "cancelled" ? "Connection replaced" : "SSH tunnel closed",
        );
      }
    } finally {
      release.resolve();
      session.child?.kill();
      await session.stopped;
      await pending.catch(() => {});
      fetching.mockRestore();
    }
  });
}
