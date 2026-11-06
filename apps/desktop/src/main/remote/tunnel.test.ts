import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { preparedHostSchema } from "../../shared/remote";
import { SshSession } from "./ssh";
import { openTunnel } from "./tunnel";
import { RemoteFailure } from "./errors";

class LocalSession extends SshSession {
  child?: ReturnType<typeof spawn>;
  stopped?: Promise<unknown>;
  hold = false;
  launched = Promise.withResolvers<void>();
  override launch({ command = [] }: Parameters<SshSession["launch"]>[0]) {
    const marker = command.join(" ").match(/TIDY_FORWARD_[a-f0-9]{32}/)?.[0];
    if (!marker) throw new Error("The tunnel command has no readiness marker.");
    const child = spawn(
      process.execPath,
      [
        "-e",
        'const ready = () => process.stdout.write(process.argv[1] + "\\n"); if (process.argv[2] === "hold") process.stdin.once("data", ready); else ready(); setInterval(() => {}, 1000)',
        marker,
        this.hold ? "hold" : "ready",
      ],
      { stdio: "pipe" },
    );
    this.child = child;
    this.stopped = once(child, "close");
    this.launched.resolve();
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

for (const outcome of ["ready", "closed"] as const) {
  test(`tunnel admission waits for SSH forwarding readiness: ${outcome}`, async () => {
    const session = new LocalSession({
      target: "fixture",
      temporaryDirectory: "unused",
      prompt: async () => null,
    });
    session.hold = true;
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
    const originalFetch = globalThis.fetch;
    const fetching = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => Response.json({ ...host, activeRuns: 0 }), {
        preconnect: originalFetch.preconnect,
      }),
    );
    const controller = new AbortController();
    const pending = openTunnel({ ssh: session, host, signal: controller.signal });
    try {
      await session.launched.promise;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetching).not.toHaveBeenCalled();
      if (outcome === "closed") {
        session.child?.kill();
        await expect(pending).rejects.toThrow("SSH tunnel closed");
        expect(fetching).not.toHaveBeenCalled();
      } else {
        session.child?.stdin?.write("\n");
        const tunnel = await pending;
        expect(fetching).toHaveBeenCalledTimes(1);
        tunnel.close();
      }
    } finally {
      controller.abort();
      session.child?.kill();
      await session.stopped;
      await pending.catch(() => {});
      fetching.mockRestore();
    }
  });
}

for (const parsing of ["rejected", "mismatch"] as const) {
  for (const outcome of ["ready", "cancelled", "closed"] as const) {
    test(`tunnel ${parsing} health preserves ${outcome} error precedence`, async () => {
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
      const parsingError = new RemoteFailure("protocol", "Health parsing failed");
      const fetching = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async () => {
            const response = Response.json({ ...host, hostId: randomUUID(), activeRuns: 0 });
            response.json = async () => {
              entered.resolve();
              await release.promise;
              if (parsing === "rejected") throw parsingError;
              return { ...host, hostId: randomUUID(), activeRuns: 0 };
            };
            return response;
          },
          { preconnect: originalFetch.preconnect },
        ),
      );
      const controller = new AbortController();
      const reason = new Error("Connection replaced");
      const pending = openTunnel({ ssh: session, host, signal: controller.signal });
      try {
        await entered.promise;
        if (outcome === "cancelled") controller.abort(reason);
        if (outcome === "closed") {
          session.child?.kill();
          await session.stopped;
        }
        release.resolve();
        const error = await pending.catch((error: unknown) => error);
        if (outcome === "cancelled") expect(error).toBe(reason);
        else if (outcome === "closed")
          expect(error).toMatchObject({ kind: "unavailable", message: "SSH tunnel closed." });
        else if (parsing === "rejected") expect(error).toBe(parsingError);
        else expect(error).toMatchObject({ kind: "identity" });
      } finally {
        release.resolve();
        session.child?.kill();
        await session.stopped;
        await pending.catch(() => {});
        fetching.mockRestore();
      }
    });
  }
}
