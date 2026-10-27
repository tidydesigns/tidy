import { version } from "../../package.json";
import { DesktopAnalytics } from "./analytics";
import {
  app,
  autoUpdater,
  BrowserWindow,
  nativeTheme,
  net,
  protocol,
  powerMonitor,
  session,
  safeStorage,
  shell,
} from "electron";
import { join } from "node:path";
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

app.setName("Tidy");
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
    const store = new ProjectStore(
      join(app.getPath("userData"), "workspace"),
      "tidy://app/__tidy/assets",
    );
    await store.initialize();
    await store.recover();
    service = new WorkspaceService(store);
    registerWorkspaceIPC(service, entryURL);
    harnessUpdates = new HarnessUpdates({
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
    cloud = new CloudService(auth, service, privateState);
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
    registerCloudIPC(cloud, entryURL);
    // Do not put credential reads, catch-up, or network access on the first-paint path.
    void cloud.initialize();
    updates = new AppUpdates({
      supported: app.isPackaged && process.platform === "darwin" && process.arch === "arm64",
      version,
      arch: process.arch,
      native: autoUpdater,
      fetch: net.fetch.bind(net),
      async prepareInstall() {
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
            (projectId, assetId) => cloud!.loadAsset(projectId, assetId),
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
          permission === "local-fonts" &&
            details.isMainFrame &&
            trustedRendererURL(contents.mainFrame.url, entryURL) &&
            Boolean(BrowserWindow.fromWebContents(contents)),
        );
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        permission === "local-fonts" &&
        details.isMainFrame &&
        Boolean(contents && trustedRendererURL(contents.mainFrame.url, entryURL)) &&
        Boolean(contents && BrowserWindow.fromWebContents(contents)),
    );

    await createWindow();

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
  void Promise.allSettled([
    service.close(),
    harnessUpdates?.close(),
    cloud?.close(),
    analytics?.close(),
  ]).finally(() => app.quit());
});
