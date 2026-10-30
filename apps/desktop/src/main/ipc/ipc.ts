import { writeFile } from "node:fs/promises";
import {
  terminalInputSchema,
  terminalScopeSchema,
  type TerminalWatch,
  type TerminalInput,
  type TerminalOutput,
} from "../../shared/contracts/terminal";
import {
  browserScopeSchema,
  BROWSER_CLIPBOARD_LIMIT,
  browserInputEnvelopeSchema,
  type BrowserWatch,
  type BrowserOutput,
  type BrowserInputEnvelope,
} from "../../shared/contracts/browser";
import { openConnectedChatLink } from "../workspace/chat-links";
import { discoverTailnet } from "../remote/tailscale";
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { basename } from "node:path";
import { WorkspaceService } from "../workspace/workspace-service";
import { trustedRendererURL } from "../app/renderer-security";
import { readLocalFile } from "../platform/local-files";
import { createWorkspaceRequests } from "./workspace-requests";
import {
  machineIdSchema,
  type WorkspaceMachine,
  remoteTargetSchema,
  type RemoteMachine,
} from "../../shared/remote";
import type { RemoteClient } from "../remote/client";
import { z } from "zod";
import { workspaceOperationSchema } from "../../shared/contracts/workspace-response";

import type { AppUpdates } from "../app/app-updates";
import type { HarnessUpdates } from "../harnesses/harness-updates";
import { updatableHarnessIdSchema } from "../../shared/contracts/harness-updates";
import { projectSnapshotSchema } from "../../shared/contracts/workspace-response";
import {
  cloudAccountSchema,
  cloudFilesSchema,
  cloudStateSchema,
  cloudCatalogSchema,
  cloudOpenedSchema,
  cloudThumbnailSchema,
  cloudAvatarSchema,
  type CloudAPI,
} from "../../shared/contracts/cloud-sync";

/** Native cloud actions have their own main-frame boundary; no tokens cross IPC. */
export function registerCloudIPC(
  cloud: CloudAPI,
  rendererURL: string,
  workspace: WorkspaceService,
) {
  function endpoint<I extends unknown[], O>(
    input: z.ZodType<I>,
    output: z.ZodType<O>,
    run: (...args: NoInfer<I>) => Promise<O>,
  ) {
    return async (args: unknown[]) => output.parse(await run(...input.parse(args)));
  }
  const org = z.string().min(1).max(120);
  const actions = {
    "creator-avatar": endpoint(
      z.tuple([z.uuid(), z.string().min(1).max(2048), z.string().min(1).max(2048)]),
      cloudAvatarSchema,
      (file, creator, version) => cloud.creatorAvatar(file, creator, version),
    ),
    thumbnail: endpoint(
      z.tuple([z.uuid(), z.string().max(120)]),
      cloudThumbnailSchema,
      (file, version) => cloud.thumbnail(file, version),
    ),
    state: endpoint(z.tuple([]), cloudStateSchema, () => cloud.state()),
    "sign-in": endpoint(z.tuple([]), z.void(), () => cloud.signIn()),
    "sign-out": endpoint(z.tuple([]), z.void(), () => cloud.signOut()),
    account: endpoint(z.tuple([z.boolean().optional()]), cloudAccountSchema, (cached?: boolean) =>
      cloud.account(cached),
    ),
    catalog: endpoint(
      z.tuple([org, z.boolean().optional()]),
      cloudCatalogSchema,
      (id: string, cached?: boolean) => cloud.catalog(id, cached),
    ),
    "open-workspace": endpoint(z.tuple([org]), projectSnapshotSchema, (id) =>
      cloud.openWorkspace(id),
    ),
    "open-file": endpoint(z.tuple([org, z.uuid()]), cloudOpenedSchema, (id, file) =>
      cloud.openFile(id, file),
    ),
    "create-file": endpoint(z.tuple([org]), cloudOpenedSchema, (id) => cloud.createFile(id)),
    "keep-both": endpoint(
      z.tuple([org, z.uuid(), z.uuid()]),
      cloudOpenedSchema,
      (organization, project, design) => cloud.keepBoth(organization, project, design),
    ),
    focus: endpoint(
      z.tuple([z.uuid().optional(), z.uuid().optional()]),
      z.void(),
      (projectId?: string, designId?: string) => cloud.focus(projectId, designId),
    ),
    files: endpoint(z.tuple([org]), cloudFilesSchema, (id) => cloud.files(id)),
    open: endpoint(
      z.tuple([z.uuid(), z.uuid(), z.string().min(1).max(120)]),
      z.void(),
      (project, file, name) => cloud.open(project, file, name),
    ),
    disconnect: endpoint(z.tuple([z.uuid(), z.uuid()]), z.void(), (project, design) =>
      cloud.disconnect(project, design),
    ),
    connect: endpoint(
      z.tuple([z.uuid(), z.uuid(), org]),
      z.void(),
      (project, design, organization) => cloud.connectLocal(project, design, organization),
    ),
  };
  for (const [name, invoke] of Object.entries(actions))
    ipcMain.handle(`tidy:cloud-${name}`, async (event, ...args: unknown[]) => {
      if (!trustedRequest(event, rendererURL)) throw new Error("Untrusted desktop request.");
      return workspace.dispatch<unknown>(() => invoke(args));
    });
  return cloud.onState((state) => {
    for (const window of BrowserWindow.getAllWindows())
      if (
        !window.isDestroyed() &&
        trustedRendererURL(window.webContents.mainFrame.url, rendererURL)
      )
        window.webContents.send("tidy:cloud-state", state);
  });
}

/** Accept requests only from an app-owned window's main frame at the expected renderer URL. */
function trustedRequest(event: IpcMainInvokeEvent, rendererURL: string) {
  return Boolean(
    BrowserWindow.fromWebContents(event.sender) &&
    event.senderFrame === event.sender.mainFrame &&
    trustedRendererURL(event.senderFrame.url, rendererURL),
  );
}

/** Renderer callers supply only an allowlisted harness ID, never a command/path/version. */
export function registerHarnessUpdateIPC(updates: HarnessUpdates, rendererURL: string) {
  ipcMain.handle("tidy:harness-updates", (event, ...args: unknown[]) => {
    if (!trustedRequest(event, rendererURL) || args.length)
      throw new Error("Untrusted desktop request.");
    return updates.state;
  });
  ipcMain.handle("tidy:install-harness-update", (event, ...args: unknown[]) => {
    if (!trustedRequest(event, rendererURL) || args.length !== 1)
      throw new Error("Untrusted desktop request.");
    const id = updatableHarnessIdSchema.safeParse(args[0]);
    if (!id.success) throw new Error("Invalid harness update request.");
    updates.install(id.data);
  });
  return updates.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        !window.isDestroyed() &&
        trustedRendererURL(window.webContents.mainFrame.url, rendererURL)
      )
        window.webContents.send("tidy:harness-updates", state);
    }
  });
}

/** Expose argument-free update actions to trusted app frames and return broadcast cleanup. */
export function registerUpdateIPC(updates: AppUpdates, rendererURL: string) {
  for (const name of ["update-state", "check-updates", "install-update"]) {
    ipcMain.handle(`tidy:${name}`, async (event, ...args: unknown[]) => {
      if (!trustedRequest(event, rendererURL) || args.length)
        throw new Error("Untrusted desktop request.");
      if (name === "update-state") return updates.state;
      if (name === "check-updates") return updates.check();
      await updates.install();
    });
  }
  return updates.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        !window.isDestroyed() &&
        trustedRendererURL(window.webContents.mainFrame.url, rendererURL)
      )
        window.webContents.send("tidy:update", state);
    }
  });
}

export function registerWorkspaceIPC(
  service: WorkspaceService,
  rendererURL: string,
  remote: {
    get(id: number): RemoteClient | undefined;
    getMachine?(id: string): RemoteClient | undefined;
    list?(): WorkspaceMachine[];
    connectivity?(input: { kind: "network"; online: boolean } | { kind: "network-changed" }): void;
    open(target: string): Promise<void>;
    machines(): RemoteMachine[];
    discover(): Promise<{ alias: string }[]>;
    forget(id: string): Promise<void>;
  } = {
    get: () => undefined,
    open: async () => {
      throw new Error("Remote setup is unavailable.");
    },
    machines: () => [],
    discover: async () => [],
    forget: async () => {},
  },
) {
  function trusted(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame ||
      !trustedRendererURL(event.senderFrame.url, rendererURL)
    )
      throw new Error("Untrusted desktop request.");
  }
  function clientFor(event: IpcMainInvokeEvent, scope: unknown) {
    if (scope === undefined) return remote.get(event.sender.id);
    const id = machineIdSchema.parse(scope);
    if (id === "local") return remote.get(event.sender.id);
    const client = remote.getMachine?.(id);
    if (!client) throw new Error("This machine is not connected. Reconnect it before continuing.");
    return client;
  }
  const terminalWatches = new Map<
    string,
    { watch?: TerminalWatch; pending: TerminalInput[]; cleanup(): void }
  >();
  ipcMain.handle("tidy:terminal-watch", async (event, raw: unknown) => {
    trusted(event);
    const { watchId, machineId, ...scope } = terminalScopeSchema
      .extend({ watchId: z.uuid(), machineId: machineIdSchema.optional() })
      .strict()
      .parse(raw);
    const key = `${event.sender.id}:${watchId}`;
    if (terminalWatches.has(key) || terminalWatches.size >= 16)
      throw new Error("Too many terminal viewers.");
    let closed = false;
    const navigated = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (details.isMainFrame && !details.isSameDocument) destroy();
    };
    const destroy = () => {
      closed = true;
      entry.watch?.close();
      terminalWatches.delete(key);
      event.sender.removeListener("destroyed", destroy);
      event.sender.removeListener("did-start-navigation", navigated);
    };
    const entry: { watch?: TerminalWatch; pending: TerminalInput[]; cleanup(): void } = {
      pending: [],
      cleanup: destroy,
    };
    terminalWatches.set(key, entry);
    event.sender.once("destroyed", destroy);
    event.sender.on("did-start-navigation", navigated);
    const send = (output: TerminalOutput) => {
      if (
        !closed &&
        !event.sender.isDestroyed() &&
        trustedRendererURL(event.sender.mainFrame.url, rendererURL)
      )
        event.sender.send("tidy:terminal-output", { watchId, output });
    };
    try {
      const client = clientFor(event, machineId);
      entry.watch = client
        ? client.watchTerminal(scope, send)
        : await service.dispatch(() => service.terminal.watch(scope, send, () => !closed));
      if (closed) entry.watch.close();
      else for (const input of entry.pending.splice(0)) entry.watch.input(input);
    } catch (error) {
      destroy();
      throw error;
    }
  });
  ipcMain.on("tidy:terminal-input", (event, raw: unknown) => {
    try {
      trusted(event);
      const { watchId, input } = z
        .object({ watchId: z.uuid(), input: terminalInputSchema })
        .strict()
        .parse(raw);
      const entry = terminalWatches.get(`${event.sender.id}:${watchId}`);
      if (entry?.watch) entry.watch.input(input);
      else if (entry && entry.pending.length < 16) entry.pending.push(input);
    } catch {}
  });
  ipcMain.on("tidy:terminal-unwatch", (event, raw: unknown) => {
    try {
      trusted(event);
      terminalWatches.get(`${event.sender.id}:${z.uuid().parse(raw)}`)?.cleanup();
    } catch {}
  });
  ipcMain.handle("tidy:browser-download", async (event, raw: unknown) => {
    trusted(event);
    const { name, data } = z
      .object({
        name: z.string().min(1).max(200),
        data: z
          .string()
          .max(22 * 1024 * 1024)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })
      .strict()
      .parse(raw);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("Window unavailable.");
    const chosen = await dialog.showSaveDialog(window, {
      title: "Download file",
      defaultPath: basename(name),
    });
    if (!chosen.canceled && chosen.filePath)
      await writeFile(chosen.filePath, Buffer.from(data, "base64"));
  });
  ipcMain.handle("tidy:browser-copy", async (event, raw: unknown) => {
    trusted(event);
    const text = z.string().max(BROWSER_CLIPBOARD_LIMIT).parse(raw);
    const { clipboard } = await import("electron");
    clipboard.writeText(text);
  });
  const browserWatches = new Map<
    string,
    {
      watch?: BrowserWatch;
      closed: boolean;
      pending: BrowserInputEnvelope[];
      cleanup(): void;
    }
  >();
  const watchRequest = browserScopeSchema
    .extend({ watchId: z.uuid(), machineId: machineIdSchema.optional() })
    .strict();
  ipcMain.handle("tidy:browser-watch", async (event, raw: unknown) => {
    trusted(event);
    const { watchId, machineId, ...scope } = watchRequest.parse(raw);
    const key = `${event.sender.id}:${watchId}`;
    if (browserWatches.has(key)) throw new Error("This browser viewer is already attached.");
    const entry: {
      watch?: BrowserWatch;
      closed: boolean;
      pending: BrowserInputEnvelope[];
      cleanup(): void;
    } = { closed: false, pending: [], cleanup: () => {} };
    browserWatches.set(key, entry);
    const send = (output: BrowserOutput) => {
      if (
        entry.closed ||
        event.sender.isDestroyed() ||
        !trustedRendererURL(event.sender.mainFrame.url, rendererURL)
      )
        return;
      event.sender.send("tidy:browser-output", { watchId, output });
    };
    const navigated = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (details.isMainFrame && !details.isSameDocument) destroy();
    };
    const destroy = () => {
      entry.closed = true;
      entry.watch?.close();
      browserWatches.delete(key);
      event.sender.removeListener("destroyed", destroy);
      event.sender.removeListener("did-start-navigation", navigated);
    };
    entry.cleanup = destroy;
    event.sender.once("destroyed", destroy);
    event.sender.on("did-start-navigation", navigated);
    try {
      const client = clientFor(event, machineId);
      entry.watch = client
        ? client.watchBrowser(scope, watchId, send)
        : await service.browser.watch(scope, watchId, send);
      if (entry.closed) entry.watch.close();
      else for (const input of entry.pending.splice(0)) entry.watch.input(input);
    } catch (error) {
      destroy();
      throw error;
    } finally {
      if (entry.closed) event.sender.removeListener("destroyed", destroy);
    }
  });
  ipcMain.on("tidy:browser-input", (event, raw: unknown) => {
    try {
      trusted(event);
      const { watchId, input } = z
        .object({ watchId: z.uuid(), input: browserInputEnvelopeSchema })
        .strict()
        .parse(raw);
      const entry = browserWatches.get(`${event.sender.id}:${watchId}`);
      if (entry?.watch) entry.watch.input(input);
      else if (entry && entry.pending.length < 16) entry.pending.push(input);
    } catch {}
  });
  ipcMain.on("tidy:browser-unwatch", (event, raw: unknown) => {
    try {
      trusted(event);
      const watchId = z.uuid().parse(raw);
      const key = `${event.sender.id}:${watchId}`;
      const entry = browserWatches.get(key);
      if (entry) entry.cleanup();
    } catch {}
  });
  ipcMain.on("tidy:connectivity", (event, value: unknown) => {
    try {
      trusted(event);
      const input = z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("network"), online: z.boolean() }).strict(),
          z.object({ kind: z.literal("network-changed") }).strict(),
        ])
        .parse(value);
      remote.connectivity?.(input);
    } catch {}
  });
  ipcMain.handle("tidy:machine-list", (event) => {
    trusted(event);
    return remote.list?.() ?? null;
  });
  ipcMain.handle("tidy:remote-connect", async (event, target: unknown) => {
    trusted(event);
    const destination = remoteTargetSchema.safeParse(target);
    if (!destination.success) throw new Error("Enter an SSH alias or user@hostname.");
    await remote.open(destination.data);
  });
  ipcMain.handle("tidy:remote-machines", (event) => {
    trusted(event);
    return remote.machines();
  });
  ipcMain.handle("tidy:remote-tailnet", (event) => {
    trusted(event);
    return discoverTailnet();
  });
  ipcMain.handle("tidy:remote-discover", (event) => {
    trusted(event);
    return remote.discover();
  });
  ipcMain.handle("tidy:remote-forget", (event, id: unknown) => {
    trusted(event);
    return remote.forget(z.string().uuid().parse(id));
  });
  ipcMain.handle("tidy:remote-retry", (event, scope: unknown) => {
    trusted(event);
    clientFor(event, scope)?.retry();
  });
  ipcMain.handle("tidy:remote-verify", async (event, id: unknown, scope: unknown) => {
    trusted(event);
    const client = clientFor(event, scope);
    if (!client) throw new Error("No remote connection.");
    await shell.openExternal(client.verificationURL(z.string().uuid().parse(id)));
  });
  ipcMain.handle("tidy:remote-cancel-verification", (event, id: unknown, scope: unknown) => {
    trusted(event);
    clientFor(event, scope)?.cancelVerification(z.string().uuid().parse(id));
  });
  ipcMain.handle("tidy:remote-activity", (event, input: unknown, scope: unknown) => {
    trusted(event);
    const activity = z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("active") }).strict(),
        z.object({ kind: z.literal("network"), online: z.boolean() }).strict(),
      ])
      .parse(input);
    clientFor(event, scope)?.wake(
      activity.kind,
      activity.kind === "network" ? activity.online : true,
    );
  });
  ipcMain.handle("tidy:remote-authenticate", (event, input: unknown, scope: unknown) => {
    trusted(event);
    const client = clientFor(event, scope);
    if (!client) throw new Error("No remote connection.");
    client.authenticate(
      z
        .object({ promptId: z.string().uuid(), answer: z.string().max(4096).nullable() })
        .strict()
        .parse(input),
    );
  });
  ipcMain.handle("tidy:remote-status", (event, scope: unknown) => {
    trusted(event);
    return scope === undefined ? null : (clientFor(event, scope)?.status ?? null);
  });
  ipcMain.handle("tidy:remote-directories", async (event, path: unknown, scope: unknown) => {
    trusted(event);
    const projectPath = z.string().max(4096).parse(path);
    return clientFor(event, scope)?.request(
      "directories",
      undefined,
      projectPath ? { projectPath } : {},
    );
  });
  ipcMain.handle("tidy:remote-open-project", async (event, path: unknown, scope: unknown) => {
    trusted(event);
    const projectPath = z.string().min(1).max(4096).startsWith("/").parse(path);
    const client = clientFor(event, scope);
    if (!client) throw new Error("No remote connection.");
    return { ok: true, data: await client.operation("open-project", undefined, { projectPath }) };
  });
  ipcMain.handle("tidy:reload-app", (event, ...args: unknown[]) => {
    if (!trustedRequest(event, rendererURL) || args.length)
      throw new Error("Untrusted desktop request.");
    setImmediate(() => {
      if (!event.sender.isDestroyed() && trustedRequest(event, rendererURL)) event.sender.reload();
    });
  });
  const platform = {
    async chooseProject(event: IpcMainInvokeEvent) {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
        title: "Open project",
        properties: ["openDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async chooseDesign(event: IpcMainInvokeEvent) {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
        title: "Import Tidy design",
        properties: ["openFile"],
        filters: [{ name: "Tidy design JSON", extensions: ["json"] }],
      });
      const file = result.filePaths[0];
      if (result.canceled || !file) return null;
      return {
        name: basename(file, ".json"),
        document: JSON.parse((await readLocalFile(file)).toString("utf8")) as unknown,
      };
    },
    openExternal: (url: string) => shell.openExternal(url),
    showItemInFolder: (path: string) => shell.showItemInFolder(path),
  };
  const requests = createWorkspaceRequests(service, platform);
  async function invoke(
    event: IpcMainInvokeEvent,
    name: import("../../shared/contracts/workspace-response").WorkspaceOperation,
    input: unknown,
    scope?: unknown,
  ) {
    try {
      trusted(event);
      const client = clientFor(event, scope);
      if (client && name === "open-chat-link") {
        await openConnectedChatLink({
          input,
          platform,
          getLocalProjectRoot:
            scope === undefined || scope === "local"
              ? async (projectId) => {
                  const snapshot = projectSnapshotSchema.parse(
                    await client.operation("project-snapshot", projectId),
                  );
                  if (snapshot.project.id !== projectId)
                    throw new Error("The project identity does not match.");
                  return snapshot.project.path;
                }
              : undefined,
        });
        return { ok: true, data: undefined };
      }
      if (client && name !== "harness-usage-page") {
        const file = name === "import-design" ? await platform.chooseDesign(event) : undefined;
        if (name === "import-design" && !file) return { ok: true, data: null };
        const projectPath =
          name === "open-project" && (scope === undefined || scope === "local")
            ? await platform.chooseProject(event)
            : undefined;
        if (name === "open-project" && projectPath === null) return { ok: true, data: null };
        return {
          ok: true,
          data: await client.operation(
            name,
            input,
            file ? { file } : projectPath ? { projectPath } : undefined,
          ),
        };
      }
      return { ok: true, data: await requests.invoke(name, input, event) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "The operation could not be completed.",
      };
    }
  }
  ipcMain.handle("tidy:workspace", (event, value: unknown) => {
    trusted(event);
    const request = z
      .object({
        machineId: machineIdSchema.optional(),
        name: workspaceOperationSchema,
        input: z.unknown().optional(),
      })
      .strict()
      .parse(value);
    return invoke(event, request.name, request.input, request.machineId);
  });
  for (const name of requests.names) {
    ipcMain.handle(`tidy:${name}`, (event, input: unknown) =>
      invoke(event, workspaceOperationSchema.parse(name), input),
    );
  }
  return service.subscribeRenderer((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        !window.isDestroyed() &&
        !remote.get(window.webContents.id) &&
        trustedRendererURL(window.webContents.mainFrame.url, rendererURL)
      )
        window.webContents.send("tidy:event", event);
    }
  });
}
import { analyticsChoicesSchema } from "@tidy/design/analytics";
import type { DesktopAnalytics } from "../analytics";

/** Privacy capabilities never expose bearer receipts or arbitrary capture/network access. */
export function registerAnalyticsIPC(analytics: DesktopAnalytics, rendererURL: string) {
  let lastPerformance = 0;
  analytics.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        !window.isDestroyed() &&
        trustedRendererURL(window.webContents.mainFrame.url, rendererURL)
      )
        window.webContents.send("tidy:privacy-state", state);
    }
  });
  ipcMain.handle("tidy:analytics", async (event, action: unknown, ...args: unknown[]) => {
    if (!trustedRequest(event, rendererURL)) throw new Error("Untrusted desktop request.");
    if (action === "choose" && args.length === 1)
      return analytics.choose(analyticsChoicesSchema.parse(args[0]));
    if (
      action === "performance" &&
      args.length === 1 &&
      ["under_100ms", "under_1s", "under_5s", "over_5s"].includes(String(args[0]))
    ) {
      if (Date.now() - lastPerformance >= 60_000) {
        lastPerformance = Date.now();
        analytics.capture({
          name: "desktop_performance",
          operation: "interaction",
          duration: args[0] as "under_100ms" | "under_1s" | "under_5s" | "over_5s",
        });
      }
      return;
    }
    if (args.length) throw new Error("Invalid privacy request.");
    if (action === "state") {
      return analytics.state();
    }
    if (action === "link") return analytics.link();
    if (action === "unlink") return analytics.unlink();
    if (action === "erase") return analytics.erase();
    if (action === "reports") return analytics.reports();
    if (action === "policy") return analytics.policy();
    if (action === "renderer-error") {
      analytics.error("renderer");
      return;
    }
    throw new Error("Invalid privacy request.");
  });
}
