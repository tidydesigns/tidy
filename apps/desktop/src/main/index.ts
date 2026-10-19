import { version } from "../../package.json";
import { app, BrowserWindow, nativeTheme, net, protocol, session } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import { registerWorkspaceIPC } from "./ipc";
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
let quitting = false;

async function createWindow() {
  const window = new BrowserWindow({
    title: "Tidy",
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 480,
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
    const store = new ProjectStore(join(app.getPath("userData"), "workspace"));
    await store.initialize();
    await store.recover();
    service = new WorkspaceService(store);
    registerWorkspaceIPC(service, entryURL);
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
  if (quitting || !service) return;
  event.preventDefault();
  quitting = true;
  void service.close().finally(() => app.quit());
});
