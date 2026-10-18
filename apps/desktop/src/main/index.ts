import { app, BrowserWindow, nativeTheme, session } from "electron";
import { join } from "node:path";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import { registerWorkspaceIPC } from "./ipc";

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
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

app.setName("Tidy");
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
    registerWorkspaceIPC(service);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

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
