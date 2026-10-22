import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { basename } from "node:path";
import { WorkspaceService } from "./workspace-service";
import { trustedRendererURL } from "./renderer-security";
import { readLocalFile } from "./local-files";
import { createWorkspaceRequests } from "./workspace-requests";
import type { AppUpdates } from "./app-updates";
import type { HarnessUpdates } from "./harness-updates";
import { updatableHarnessIdSchema } from "../shared/harness-updates";
import { z } from "zod";
import {
  cloudAccountSchema,
  cloudFilesSchema,
  cloudStateSchema,
  type CloudAPI,
} from "../shared/cloud-sync";

/** Native cloud actions have their own main-frame boundary; no tokens cross IPC. */
export function registerCloudIPC(cloud: CloudAPI, rendererURL: string) {
  const pair = z.tuple([z.uuid(), z.uuid()]);
  const actions = {
    state: { input: z.tuple([]), output: cloudStateSchema, run: () => cloud.state() },
    "sign-in": { input: z.tuple([]), output: z.void(), run: () => cloud.signIn() },
    "sign-out": { input: z.tuple([]), output: z.void(), run: () => cloud.signOut() },
    account: { input: z.tuple([]), output: cloudAccountSchema, run: () => cloud.account() },
    files: {
      input: z.tuple([z.string().min(1).max(120)]),
      output: cloudFilesSchema,
      run: (...args: string[]) => cloud.files(args[0]),
    },
    open: {
      input: z.tuple([z.uuid(), z.uuid(), z.string().min(1).max(120)]),
      output: z.void(),
      run: (...args: string[]) => cloud.open(args[0], args[1], args[2]),
    },
    disconnect: {
      input: pair,
      output: z.void(),
      run: (...args: string[]) => cloud.disconnect(args[0], args[1]),
    },
    connect: {
      input: z.tuple([z.uuid(), z.uuid(), z.string().min(1).max(120)]),
      output: z.void(),
      run: (...args: string[]) => cloud.connectLocal(args[0], args[1], args[2]),
    },
  };
  for (const [name, action] of Object.entries(actions))
    ipcMain.handle(`tidy:cloud-${name}`, async (event, ...args: unknown[]) => {
      if (!trustedRequest(event, rendererURL)) throw new Error("Untrusted desktop request.");
      const parsed = action.input.parse(args);
      return action.output.parse(await action.run(...parsed));
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

/** Register validated workspace operations and forward events only to trusted app renderers. */
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
