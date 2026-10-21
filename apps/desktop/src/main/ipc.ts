import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { basename } from "node:path";
import { WorkspaceService } from "./workspace-service";
import { trustedRendererURL } from "./renderer-security";
import { readLocalFile } from "./local-files";
import { createWorkspaceRequests } from "./workspace-requests";
import type { AppUpdates } from "./app-updates";

function trustedRequest(event: IpcMainInvokeEvent, rendererURL: string) {
  return Boolean(
    BrowserWindow.fromWebContents(event.sender) &&
    event.senderFrame === event.sender.mainFrame &&
    trustedRendererURL(event.senderFrame.url, rendererURL),
  );
}

export function registerUpdateIPC(updates: AppUpdates, rendererURL: string) {
  for (const name of ["update-state", "install-update"]) {
    ipcMain.handle(`tidy:${name}`, async (event, ...args: unknown[]) => {
      if (!trustedRequest(event, rendererURL) || args.length)
        throw new Error("Untrusted desktop request.");
      if (name === "update-state") return updates.state;
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

export function registerWorkspaceIPC(service: WorkspaceService, rendererURL: string) {
  const requests = createWorkspaceRequests<IpcMainInvokeEvent>(service, {
    async chooseProject(event) {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
        title: "Open project",
        properties: ["openDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async chooseDesign(event) {
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
    openExternal: (url) => shell.openExternal(url),
  });
  for (const name of requests.names) {
    ipcMain.handle(`tidy:${name}`, async (event, input: unknown) => {
      try {
        if (!trustedRequest(event, rendererURL)) throw new Error("Untrusted desktop request.");
        return { ok: true, data: await requests.invoke(name, input, event) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "The operation could not be completed.",
        };
      }
    });
  }
  return service.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        !window.isDestroyed() &&
        trustedRendererURL(window.webContents.mainFrame.url, rendererURL)
      )
        window.webContents.send("tidy:event", event);
    }
  });
}
