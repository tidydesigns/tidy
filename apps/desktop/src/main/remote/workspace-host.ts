import { mkdir, chmod, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runtimeSchema, hostDescriptorSchema, type PreparedHost } from "../../shared/remote";
import { WorkspaceService } from "../workspace/workspace-service";
import { createRemoteHost } from "./host";
import { lockHost } from "./host-lock";
import { RequestReceipts } from "./receipts";
import { SessionStore, writePrivateJSON } from "./session-store";
import { readLocalFile } from "../platform/local-files";

export const workspaceHostDirectory = () =>
  process.env.TIDY_HOST_STATE ?? join(homedir(), ".local", "state", "tidy-host");
const errorCodeSchema = z.object({ code: z.string() });
const hasErrorCode = (error: unknown, code: string) =>
  errorCodeSchema.safeParse(error).data?.code === code;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function discardStaleRuntime(directory: string) {
  let release: () => void;
  try {
    release = lockHost(join(directory, "host.lock"));
  } catch {
    return false;
  }
  try {
    await rm(join(directory, "runtime.json"), { force: true });
    return true;
  } finally {
    release();
  }
}

export async function workspaceRuntime(directory: string) {
  let runtime: z.infer<typeof runtimeSchema>;
  try {
    runtime = runtimeSchema.parse(
      JSON.parse(await readFile(join(directory, "runtime.json"), "utf8")),
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    process.kill(runtime.pid, 0);
  } catch (error) {
    if (await discardStaleRuntime(directory)) return null;
    throw error;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Backend health check failed.");
    const actual = hostDescriptorSchema.parse(await response.json());
    if (actual.hostId !== runtime.hostId || actual.instanceId !== runtime.instanceId)
      throw new Error("Backend identity mismatch.");
    return runtime;
  } catch {
    if (await discardStaleRuntime(directory)) return null;
    throw new Error(
      "The existing workspace backend is alive but unresponsive. It was left running; retry shortly.",
    );
  }
}

export async function migrateWorkspaceRegistry(source: string, destination: string) {
  try {
    await readLocalFile(join(destination, "projects.json"));
    return;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  let registry: unknown;
  try {
    registry = JSON.parse((await readLocalFile(join(source, "projects.json"))).toString("utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  const parsed = z
    .object({
      version: z.literal(1),
      activeProjectId: z.string().nullable(),
      projects: z
        .array(
          z.object({
            id: z.string().uuid(),
            name: z.string(),
            path: z.string(),
            openedAt: z.string(),
          }),
        )
        .max(100),
    })
    .parse(registry);
  await mkdir(join(destination, "thread-authority"), { recursive: true, mode: 0o700 });
  const names = await readdir(join(source, "thread-authority")).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  });
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const value = await readLocalFile(join(source, "thread-authority", name), 4096);
    try {
      await writeFile(join(destination, "thread-authority", name), value, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
  }
  await writePrivateJSON(join(destination, "projects.json"), parsed);
}

export type WorkspaceHost = {
  host: PreparedHost;
  service?: WorkspaceService;
  close(): Promise<void>;
};

export async function ensureWorkspaceHost({
  directory,
  buildId,
  createService,
  drainTimeoutMs,
}: {
  directory: string;
  buildId: string;
  drainTimeoutMs?: number;
  createService(): Promise<{ service: WorkspaceService; release(): void }>;
}): Promise<WorkspaceHost> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let releaseLaunch: (() => void) | undefined;
  for (let attempt = 0; attempt < 150 && !releaseLaunch; attempt++) {
    try {
      releaseLaunch = lockHost(join(directory, "launch.lock"));
    } catch {
      await delay(100);
    }
  }
  if (!releaseLaunch)
    throw new Error("Another client is starting the workspace backend. Retry shortly.");
  try {
    const sessions = new SessionStore(join(directory, "sessions"));
    const idPath = join(directory, "desktop-client-id");
    try {
      await writeFile(idPath, randomUUID(), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    const clientId = z
      .string()
      .uuid()
      .parse((await readFile(idPath, "utf8")).trim());
    const existing = await workspaceRuntime(directory);
    if (existing)
      return {
        host: { ...existing, clientId, token: await sessions.issue(clientId) },
        close: async () => {},
      };
    const releaseHost = lockHost(join(directory, "host.lock"));
    let workspace: Awaited<ReturnType<typeof createService>> | undefined;
    let server: ReturnType<typeof createRemoteHost> | undefined;
    try {
      const identityPath = join(directory, "identity");
      try {
        await writeFile(identityPath, randomUUID(), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }
      const hostId = z
        .string()
        .uuid()
        .parse((await readFile(identityPath, "utf8")).trim());
      workspace = await createService();
      const identity = { hostId, instanceId: randomUUID(), buildId };
      server = createRemoteHost({
        service: workspace.service,
        drainTimeoutMs,
        sessions,
        identity,
        receipts: new RequestReceipts(join(directory, "receipts")),
      });
      const port = await server.listen();
      const runtime = { ...identity, protocol: 3 as const, pid: process.pid, port, managed: false };
      await writePrivateJSON(join(directory, "runtime.json"), runtime);
      let closing: Promise<void> | undefined;
      const owned = workspace,
        host = server;
      return {
        host: { ...runtime, clientId, token: await sessions.issue(clientId) },
        service: owned.service,
        close() {
          closing ??= (async () => {
            await host.close();
            try {
              await owned.service.close();
              await rm(join(directory, "runtime.json"), { force: true });
            } finally {
              owned.release();
              releaseHost();
            }
          })();
          return closing;
        },
      };
    } catch (error) {
      await server?.close();
      await workspace?.service.close();
      workspace?.release();
      releaseHost();
      throw error;
    }
  } finally {
    releaseLaunch();
  }
}
