import { version } from "../../package.json";
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
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import {
  registerHarnessUpdateIPC,
  registerCloudIPC,
  registerUpdateIPC,
  registerWorkspaceIPC,
} from "./ipc";
import { CloudAuth } from "./cloud-auth";
import { CloudService } from "./cloud-service";
import { PrivateState } from "./private-state";
import { AppUpdates } from "./app-updates";
import { HarnessUpdates } from "./harness-updates";
import { invalidateHarnessDetails } from "./harness-details";
import {
  APP_SCHEME,
  rendererURL,
  rendererAssetPath,
  trustedRendererURL,
} from "./renderer-security";

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const entryURL = rendererURL(app.isPackaged, process.env.ELECTRON_RENDERER_URL);

let service: WorkspaceService | undefined;
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

/** Open the workspace with its platform icon and restricted renderer permissions. */
async function createWindow() {
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
  window.once("ready-to-show", () => window.show());
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
    const store = new ProjectStore(join(app.getPath("userData"), "workspace"));
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
    updates.start();
    protocol.handle(APP_SCHEME, async (request) => {
      try {
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
  void Promise.allSettled([service.close(), harnessUpdates?.close(), cloud?.close()]).finally(() =>
    app.quit(),
  );
});
