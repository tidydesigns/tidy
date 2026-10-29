import { machineConnections } from "./remote/machine-connections";
import { projectLocks } from "./remote/project-locks";
import { RemoteClient } from "./remote/client";
import { MachineProfiles } from "./remote/profiles";
import { discoverSshHosts } from "./remote/ssh";
import { version } from "../../package.json";
import { DesktopAnalytics } from "./analytics";
import {
  app,
  autoUpdater,
  BrowserWindow,
  nativeTheme,
  net,
  protocol,
  session,
  safeStorage,
  shell,
  powerMonitor,
} from "electron";
import { join } from "node:path";
import { hostname } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  ensureWorkspaceHost,
  migrateWorkspaceRegistry,
  workspaceHostDirectory,
  type WorkspaceHost,
} from "./remote/workspace-host";
import { pathToFileURL } from "node:url";
import { ProjectStore } from "./workspace/project-store";
import { projectAssetResponse } from "./workspace/project-assets";
import { WorkspaceService } from "./workspace/workspace-service";
import {
  registerHarnessUpdateIPC,
  registerCloudIPC,
  registerUpdateIPC,
  registerWorkspaceIPC,
  registerAnalyticsIPC,
} from "./ipc/ipc";
import { CloudAuth } from "./cloud/cloud-auth";
import { CloudService } from "./cloud/cloud-service";
import { PrivateState } from "./platform/private-state";
import { AppUpdates } from "./app/app-updates";
import { HarnessUpdates } from "./harnesses/harness-updates";
import { invalidateHarnessDetails } from "./harnesses/harness-details";
import {
  APP_SCHEME,
  rendererURL,
  rendererAssetPath,
  trustedRendererURL,
} from "./app/renderer-security";

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);
const entryURL = rendererURL(app.isPackaged, process.env.ELECTRON_RENDERER_URL);

let localClient: RemoteClient | undefined;
let ownedHost: WorkspaceHost | undefined;
const remoteClients = new Map<string, RemoteClient>();
let service: WorkspaceService | undefined;
let analytics: DesktopAnalytics | undefined;
let quitting: symbol | "quit" | undefined;
let updates: AppUpdates | undefined;
let harnessUpdates: HarnessUpdates | undefined;
let cloud: CloudService | undefined;
const appIcon = app.isPackaged
  ? process.platform === "linux"
    ? join(app.getAppPath(), "icon.png")
    : undefined
  : join(
      import.meta.dirname,
      "../../resources",
      process.platform === "darwin" ? "icon-macos.png" : "icon.png",
    );

async function createWindow() {
  const startedAt = Date.now();
  const window = new BrowserWindow({
    title: "Tidy",
    icon: appIcon,
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 13 } }
      : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#202020" : "#fafafa",
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  // Native fullscreen hides the traffic lights; keep the renderer's inset in sync after reloads too.
  const syncFullscreen = () => {
    if (trustedRendererURL(window.webContents.mainFrame.url, entryURL))
      window.webContents.send("tidy:window-fullscreen", window.isFullScreen());
  };
  window.on("enter-full-screen", syncFullscreen);
  window.on("leave-full-screen", syncFullscreen);
  window.webContents.on("did-finish-load", syncFullscreen);
  window.on("focus", () => {
    localClient?.wake("active");
    for (const client of remoteClients.values()) client.wake("active");
  });
  window.once("ready-to-show", () => {
    window.show();
    const duration = Date.now() - startedAt;
    analytics?.capture({
      name: "desktop_performance",
      operation: "startup",
      duration:
        duration < 100
          ? "under_100ms"
          : duration < 1000
            ? "under_1s"
            : duration < 5000
              ? "under_5s"
              : "over_5s",
    });
  });
  window.webContents.on("render-process-gone", () => analytics?.error("renderer"));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  await window.loadURL(entryURL);
}

function broadcast(channel: string, ...values: unknown[]) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && trustedRendererURL(window.webContents.mainFrame.url, entryURL))
      window.webContents.send(channel, ...values);
  }
}
const connectMachine = machineConnections(async (target) => {
  const machine = await profiles.remember(target);
  const existing = remoteClients.get(machine.id);
  if (existing) {
    existing.retry();
    return;
  }
  const client = new RemoteClient({
    machine,
    bundlePath: join(import.meta.dirname, "../host/tidy-host.js"),
    temporaryDirectory: join(app.getPath("userData"), "ssh"),
    cachePath: join(app.getPath("userData"), "remote-cache", `${machine.id}.json`),
    event: (event) => broadcast("tidy:machine-event", machine.id, event),
    statusChanged: (status) => {
      broadcast("tidy:machine-status", machine.id, status);
      broadcast("tidy:machines-changed");
    },
    connected: (hostId) => profiles.connected(machine.id, hostId),
  });
  remoteClients.set(machine.id, client);
  try {
    await profiles.setOpen(machine.id, true);
  } catch (error) {
    remoteClients.delete(machine.id);
    client.close();
    throw error;
  }
  client.start();
  broadcast("tidy:machines-changed");
});

app.setName("Tidy");
const profiles = new MachineProfiles(join(app.getPath("userData"), "remote-machines.json"));
app.setAboutPanelOptions({ applicationName: "Tidy", applicationVersion: version });
const ownsWorkspace = app.requestSingleInstanceLock();
if (!ownsWorkspace) app.quit();
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

app
  .whenReady()
  .then(async () => {
    if (!ownsWorkspace) return;
    if (process.platform === "darwin" && appIcon) app.dock?.setIcon(appIcon);
    await profiles.initialize();
    const directory = workspaceHostDirectory();
    const bundlePath = join(import.meta.dirname, "../host/tidy-host.js");
    const buildId = createHash("sha256")
      .update(await readFile(bundlePath))
      .digest("hex");
    const acquire = async () => {
      const backend = await ensureWorkspaceHost({
        directory,
        buildId,
        createService: async () => {
          const locks = projectLocks();
          try {
            await migrateWorkspaceRegistry(
              join(app.getPath("userData"), "workspace"),
              join(directory, "workspace"),
            );
            const store = new ProjectStore(
              join(directory, "workspace"),
              "tidy://app/__tidy/assets",
              locks.claim,
            );
            await store.initialize();
            await store.recover();
            return {
              service: new WorkspaceService(store),
              release: () => locks.close(),
            };
          } catch (error) {
            locks.close();
            throw error;
          }
        },
      });
      if (backend.service) ownedHost = backend;
      return backend;
    };
    const initial = await acquire();
    const ownsInitialService = Boolean(initial.service);
    service =
      initial.service ?? new WorkspaceService(new ProjectStore(join(directory, "unused-local")));
    // An owned service is already ready and is reached through direct IPC. A loopback
    // client would repeat bootstrap/recovery and agent discovery before first paint.
    // Only attach through the transport when another process owns the backend.
    if (!ownsInitialService) {
      let first = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("The local workspace backend did not become ready.")),
          75_000,
        );
        localClient = new RemoteClient({
          machine: {
            id: initial.host.clientId,
            target: "This machine",
            hostId: initial.host.hostId,
            lastConnectedAt: null,
          },
          bundlePath,
          temporaryDirectory: join(app.getPath("userData"), "ssh"),
          cachePath: join(app.getPath("userData"), "remote-cache", "local.json"),
          event: (event) => {
            broadcast("tidy:event", event);
          },
          statusChanged: (status) => {
            if (status.kind === "connected") {
              clearTimeout(timer);
              resolve();
            } else if (status.kind === "blocked") {
              clearTimeout(timer);
              reject(new Error(status.message));
            }
          },
          connected: async () => {},
          connector: async () => {
            const backend = first ? initial : await acquire();
            first = false;
            return {
              host: backend.host,
              origin: `http://127.0.0.1:${backend.host.port}`,
              close() {},
              onClose() {},
            };
          },
        });
        localClient.start();
      });
    }
    registerWorkspaceIPC(service, entryURL, {
      get: () => (ownsInitialService ? undefined : localClient),
      getMachine: (id) => remoteClients.get(id),
      list: () => [
        { id: "local", label: hostname(), status: null },
        ...profiles
          .list()
          .filter((machine) => remoteClients.has(machine.id))
          .map((machine) => ({
            id: machine.id,
            label: machine.target,
            status: remoteClients.get(machine.id)!.status,
          })),
      ],
      open: connectMachine,
      connectivity: (input) => {
        for (const client of remoteClients.values())
          client.wake(input.kind, input.kind === "network" ? input.online : true);
      },
      machines: () => profiles.list(),
      discover: () => discoverSshHosts(),
      forget: async (id) => {
        const client = remoteClients.get(id);
        client?.close();
        await client?.flush();
        remoteClients.delete(id);
        await profiles.forget(id);
        await rm(join(app.getPath("userData"), "remote-cache", `${id}.json`), { force: true });
        broadcast("tidy:machines-changed");
      },
    });
    const store = service.store;
    harnessUpdates = new HarnessUpdates({
      installDisabledReason: ownsInitialService
        ? undefined
        : "Agent updates are unavailable while attached to a background backend. Once its agents finish, stop that backend and reopen Tidy to update agents.",
      reserve: (id, options) => service!.reserveHarnessUpdate(id, options),
      installed: invalidateHarnessDetails,
    });
    registerHarnessUpdateIPC(harnessUpdates, entryURL);
    harnessUpdates.start();
    app.on("browser-window-focus", () => {
      void harnessUpdates?.check();
      cloud?.setForeground(true);
    });
    app.on("browser-window-blur", () => cloud?.setForeground(false));
    const privateState = new PrivateState(join(app.getPath("userData"), "cloud-sync"));
    const auth = new CloudAuth(
      process.env.TIDY_CLOUD_URL ?? "https://app.tidydesign.co",
      privateState,
      {
        available: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== "linux" ||
            safeStorage.getSelectedStorageBackend() !== "basic_text"),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value),
      },
      (url) => shell.openExternal(url),
    );
    cloud = new CloudService(auth, service, privateState, undefined, ownsInitialService);
    analytics = new DesktopAnalytics({
      state: new PrivateState(join(app.getPath("userData"), "privacy")),
      origin: auth.origin,
      version,
      platform: process.platform,
      arch: process.arch,
      available: app.isPackaged,
      fetch: net.fetch.bind(net),
      open: (url) => shell.openExternal(url),
    });
    registerAnalyticsIPC(analytics, entryURL);
    store.analytics =
      service.analytics =
      cloud.sync.analytics =
        (event) => {
          analytics?.record(event);
        };
    service.analyticsScope = () => analytics!.bind();
    void analytics
      .initialize()
      .then(() => analytics?.confirmUpdate())
      .catch(() => {});
    app.on("browser-window-focus", () => {
      analytics?.active();
      void analytics?.refresh();
    });
    const activity = setInterval(() => {
      if (BrowserWindow.getFocusedWindow())
        analytics?.active(() => powerMonitor.getSystemIdleTime() < 300);
    }, 60_000);
    activity.unref();
    const localCleanup = setInterval(() => {
      void analytics?.pruneLocal().catch(() => {});
    }, 60 * 60_000);
    localCleanup.unref();
    let account = auth.accountId;
    let accountObserved = false;
    cloud.onState((state) => {
      if (!accountObserved) {
        accountObserved = true;
        account = state.accountId;
        return;
      }
      if (account !== state.accountId) {
        account = state.accountId;
        void analytics
          ?.state()
          .then((value) => {
            if (value.linked) return analytics?.unlink();
          })
          .catch(() => {});
      }
    });
    const harnessStates = new Map<string, string>();
    harnessUpdates.subscribe((states) => {
      for (const state of states) {
        const before = harnessStates.get(state.id);
        harnessStates.set(state.id, state.status);
        if (before === "installing" && state.status !== "installing")
          analytics?.capture({
            name: "desktop_harness_update_result",
            harness: state.id,
            result: state.status === "updated" ? "success" : "failed",
          });
      }
    });
    registerCloudIPC(cloud, entryURL, service);
    // Do not put credential reads, catch-up, or network access on the first-paint path.
    void cloud.initialize();
    updates = new AppUpdates({
      supported: app.isPackaged && process.platform === "darwin" && process.arch === "arm64",
      version,
      arch: process.arch,
      native: autoUpdater,
      fetch: net.fetch.bind(net),
      async prepareInstall() {
        if (!ownsInitialService)
          throw new Error(
            "Once background agents finish, stop the background backend and reopen Tidy to install this update.",
          );
        if (harnessUpdates?.busy) throw new Error("Wait for harness updates to finish.");
        const resumeWorkspace = await service!.prepareUpdate();
        const update = Symbol("update");
        if (!quitting) quitting = update;
        return () => {
          if (quitting === update) quitting = undefined;
          resumeWorkspace();
        };
      },
    });
    registerUpdateIPC(updates, entryURL);
    updates.subscribe((state) => {
      if (state.status === "error" || (state.status === "ready" && state.error))
        analytics?.error("update");
      if (state.status === "ready" && state.version && !state.error)
        analytics?.capture({
          name: "desktop_update_result",
          stage: "download",
          result: "success",
          from: version,
          to: state.version,
        });
      if (state.status === "installing" && state.version)
        void analytics?.updateTarget(state.version).catch(() => {});
      if (
        ((state.status === "error" && state.error === "download") ||
          (state.status === "ready" && state.error === "install")) &&
        state.version
      )
        analytics?.capture({
          name: "desktop_update_result",
          stage: state.error === "download" ? "download" : "install",
          result: "failed",
          from: version,
          to: state.version,
        });
    });
    updates.start();
    protocol.handle(APP_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        if (url.host !== "app" || url.username || url.password)
          return new Response(null, { status: 404 });
        if (url.pathname.startsWith("/__tidy/assets/"))
          return projectAssetResponse(
            store,
            request,
            entryURL.startsWith("http") ? new URL(entryURL).origin : undefined,
            (projectId) => service!.assertProjectAccess(projectId),
            (projectId, assetId) => service!.dispatch(() => cloud!.loadAsset(projectId, assetId)),
          );
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response(null, { status: 405 });
        const path = rendererAssetPath(join(import.meta.dirname, "../renderer"), request.url);
        return await net.fetch(pathToFileURL(path).href);
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        callback(
          (permission === "local-fonts" || permission === "clipboard-sanitized-write") &&
            details.isMainFrame &&
            trustedRendererURL(contents.mainFrame.url, entryURL) &&
            Boolean(BrowserWindow.fromWebContents(contents)),
        );
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        (permission === "local-fonts" || permission === "clipboard-sanitized-write") &&
        details.isMainFrame &&
        Boolean(contents && trustedRendererURL(contents.mainFrame.url, entryURL)) &&
        Boolean(contents && BrowserWindow.fromWebContents(contents)),
    );

    const restore = profiles.list().filter((machine) => machine.restoreOnLaunch);
    await createWindow();
    powerMonitor.on("suspend", () => {
      localClient?.suspend();
      for (const client of remoteClients.values()) client.suspend();
    });
    powerMonitor.on("resume", () => {
      localClient?.wake("resume");
      for (const client of remoteClients.values()) client.wake("resume");
    });

    for (const machine of restore)
      await connectMachine(machine.target).catch(() => {
        console.error("Could not restore a saved machine connection.");
      });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  })
  .catch((error: unknown) => {
    console.error("Failed to start Tidy desktop:", error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  // Update restarts still need native errors to restore the prepared workspace.
  if (!quitting) updates?.stop();
  if (quitting || !service) return;
  event.preventDefault();
  quitting = "quit";
  for (const client of remoteClients.values()) client.close();
  localClient?.close();
  const closingService = service;
  const closeWorkspace = async () => {
    await Promise.all([harnessUpdates?.close(), cloud?.close()]);
    await (ownedHost ? ownedHost.close() : closingService.close());
  };
  void Promise.allSettled([
    closeWorkspace(),
    analytics?.close(),
    profiles.flush(),
    localClient?.flush(),
    ...[...remoteClients.values()].map((client) => client.flush()),
  ]).finally(() => app.quit());
});
