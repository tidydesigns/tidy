import { workspaceRuntime } from "../src/main/remote/workspace-host";
import { startInteractiveHarness } from "../src/main/harnesses/interactive-harness";
import { chmod, mkdir, open, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { ProjectStore } from "../src/main/workspace/project-store";
import { WorkspaceService } from "../src/main/workspace/workspace-service";
import { projectLocks } from "../src/main/remote/project-locks";
import { lockHost } from "../src/main/remote/host-lock";
import { createRemoteHost } from "../src/main/remote/host";
import { RequestReceipts } from "../src/main/remote/receipts";
import { SessionStore, writePrivateJSON } from "../src/main/remote/session-store";

const directory = process.env.TIDY_HOST_STATE ?? join(homedir(), ".local", "state", "tidy-host");
const runtimePath = join(directory, "runtime.json");
const command = process.argv[2];
const buildId = createHash("sha256")
  .update(await readFile(import.meta.filename))
  .digest("hex");
const sessions = new SessionStore(join(directory, "sessions"));
process.umask(0o077);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ready = () => workspaceRuntime(directory);

try {
  if (command === "ensure") {
    const clientId = z.string().uuid().parse(process.argv[3]);
    let release: (() => void) | undefined;
    for (let attempt = 0; attempt < 100 && !release; attempt++) {
      try {
        release = lockHost(join(directory, "launch.lock"));
      } catch {
        await delay(100);
      }
    }
    if (!release) throw new Error("Another connection is starting this backend. Retry shortly.");
    try {
      const token = await sessions.issue(clientId);
      let runtime = await ready();
      if (runtime && runtime.buildId !== buildId && runtime.managed) {
        const previous = runtime;
        const response = await fetch(`http://127.0.0.1:${runtime.port}/maintenance/restart`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "X-Tidy-Client": clientId },
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        if (response.ok) {
          for (let attempt = 0; attempt < 100; attempt++) {
            await delay(100);
            try {
              process.kill(previous.pid, 0);
            } catch {
              runtime = null;
              break;
            }
          }
          if (runtime)
            throw new Error("The previous backend is still shutting down. Retry shortly.");
        } else if (response.status !== 409)
          throw new Error("The existing backend needs a manual restart before updating.");
      }
      if (!runtime) {
        const log = await open(join(directory, "server.log"), "a", 0o600);
        try {
          const child = spawn(
            process.execPath,
            [...process.execArgv, import.meta.filename, "serve", "--managed"],
            {
              detached: true,
              stdio: ["ignore", log.fd, log.fd],
              env: process.env,
            },
          );
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          child.unref();
        } finally {
          await log.close();
        }
        for (let attempt = 0; attempt < 300; attempt++) {
          runtime = await ready();
          if (runtime) break;
          await delay(200);
        }
        if (!runtime)
          throw new Error(
            "The backend did not become ready. Inspect ~/.local/state/tidy-host/server.log.",
          );
      }
      process.stdout.write(JSON.stringify({ ...runtime, clientId, token }) + "\n");
    } finally {
      release();
    }
  } else if (command === "serve") {
    const unlock = lockHost(join(directory, "host.lock"));
    const identityPath = join(directory, "identity");
    try {
      await writeFile(identityPath, randomUUID(), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const hostId = z
      .string()
      .uuid()
      .parse((await readFile(identityPath, "utf8")).trim());
    const locks = projectLocks();
    const store = new ProjectStore(join(directory, "workspace"), "/__tidy/assets", locks.claim);
    const service = new WorkspaceService(store, (input) =>
      startInteractiveHarness({ ...input, superviseParent: true }),
    );
    const identity = { hostId, instanceId: randomUUID(), buildId };
    const host = createRemoteHost({
      service,
      identity,
      sessions,
      receipts: new RequestReceipts(join(directory, "receipts")),
      ...(process.argv.includes("--managed") ? { shutdown: () => close() } : {}),
    });
    await store.initialize();
    await store.recover();
    const port = await host.listen();
    await writePrivateJSON(runtimePath, {
      ...identity,
      protocol: 3,
      port,
      pid: process.pid,
      managed: process.argv.includes("--managed"),
    });
    process.stderr.write(JSON.stringify({ event: "host.ready", port, hostId }) + "\n");
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void host
        .close()
        .then(() => service.close())
        .then(() => rm(runtimePath, { force: true }))
        .then(() => {
          locks.close();
          unlock();
          process.exit(0);
        })
        .catch((error: unknown) => {
          process.stderr.write(
            JSON.stringify({
              event: "host.shutdown-failed",
              message: error instanceof Error ? error.message : "Backend shutdown failed.",
            }) + "\n",
          );
          process.exit(1);
        });
    };
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  } else if (command === "revoke") {
    await sessions.revoke(z.string().uuid().parse(process.argv[3]));
  } else if (command === "version") {
    process.stdout.write(JSON.stringify({ protocol: 3, buildId }) + "\n");
  } else throw new Error("Usage: tidy-host serve | ensure CLIENT_ID | revoke CLIENT_ID | version");
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      event: "host.failed",
      message: error instanceof Error ? error.message : "Backend failed.",
    }) + "\n",
  );
  process.exitCode = 1;
}
