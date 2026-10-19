import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { basename } from "node:path";
import { WorkspaceService } from "./workspace-service";
import { trustedRendererURL } from "./renderer-security";
import { readLocalFile } from "./local-files";
import { createWorkspaceRequests } from "./workspace-requests";

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
        if (
          !BrowserWindow.fromWebContents(event.sender) ||
          event.senderFrame !== event.sender.mainFrame ||
          !trustedRendererURL(event.senderFrame.url, rendererURL)
        )
          throw new Error("Untrusted desktop request.");
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
