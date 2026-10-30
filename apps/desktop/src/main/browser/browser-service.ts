import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page, CDPSession, Dialog } from "puppeteer-core";
import {
  browserURL,
  isBrowserQuery,
  emptyBrowserState,
  type BrowserScope,
  type BrowserState,
  type BrowserAction,
  type BrowserInput,
  type BrowserWatch,
  type BrowserResult,
} from "../../shared/contracts/browser";
import { BrowserScreencast, type BrowserViewer } from "./screencast";
import { BrowserRuntime } from "./runtime";

type Tab = {
  page: Page;
  cdp: CDPSession;
  state: BrowserState["tabs"][number];
  console: string[];
  dialog: { id: string; value: Dialog } | null;
  navigation: number;
  navigationController?: AbortController;
  frameId: string;
  frameIds: Set<string>;
  chooser: { id: string; backendNodeId: number; multiple: boolean } | null;
  uploads: string[];
  uploadBytes: number;
  uploadBatches: number;
  downloads: Map<
    string,
    Omit<BrowserState["downloads"][number], "id" | "tabId"> & { path: string }
  >;
};
type Workspace = {
  scope: BrowserScope;
  lifetime: AbortController;
  tabs: Map<string, Tab>;
  activeTabId: string | null;
  context?: Promise<BrowserContext>;
  phase: BrowserState["phase"];
  controller: string | null;
  controlGeneration: number;
  renderTask: Promise<void>;
  stream: BrowserScreencast;
  opening: Set<string>;
  downloadsDirectory?: string;
  downloadSession?: CDPSession;
  agentActions: Set<AbortController>;
};
const scopeKey = (scope: BrowserScope) => `${scope.projectId}:${scope.threadId}`;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 1000) : "Browser action failed.";
const ignored = () => {};

export class BrowserService {
  private readonly workspaces = new Map<string, Workspace>();
  private closing = false;
  private cleanupPromises = new Set<Promise<unknown>>();
  private readonly runtime = new BrowserRuntime(
    (progress) => {
      for (const workspace of this.workspaces.values()) {
        if (workspace.phase.kind === "starting" || workspace.phase.kind === "installing") {
          workspace.phase =
            progress === null ? { kind: "starting" } : { kind: "installing", progress };
          this.broadcast(workspace);
        }
      }
    },
    () => this.disconnected(),
  );

  constructor(private readonly authorize: (scope: BrowserScope) => Promise<void>) {}

  private cleanup(action: Promise<unknown>) {
    this.cleanupPromises.add(action);
    void action.finally(() => this.cleanupPromises.delete(action)).catch(ignored);
  }

  private disconnected() {
    if (this.closing) return;
    for (const workspace of this.workspaces.values()) {
      if (!workspace.context) continue;
      workspace.context = undefined;
      workspace.stream.reset();
      workspace.downloadSession = undefined;
      this.setController(workspace, null);
      for (const action of workspace.agentActions)
        action.abort(new Error("The host browser stopped."));
      for (const tab of workspace.tabs.values()) {
        this.pressedKeys.delete(tab.state.id);
        this.pressedButtons.delete(tab.state.id);
        for (const path of tab.uploads) this.cleanup(rm(path, { recursive: true, force: true }));
      }
      if (workspace.downloadsDirectory)
        this.cleanup(rm(workspace.downloadsDirectory, { recursive: true, force: true }));
      workspace.downloadsDirectory = undefined;
      workspace.tabs.clear();
      workspace.activeTabId = null;
      workspace.phase = {
        kind: "error",
        message: "The host browser stopped. Open a page to start it again.",
      };
      this.broadcast(workspace);
    }
  }

  private workspace(scope: BrowserScope) {
    if (this.closing) throw new Error("The browser is closing.");
    const key = scopeKey(scope);
    let workspace = this.workspaces.get(key);
    if (!workspace) {
      if (this.workspaces.size >= 64) throw new Error("Close an unused browser workspace first.");
      const created: Workspace = {
        scope,
        lifetime: new AbortController(),
        tabs: new Map(),
        activeTabId: null,
        phase: { kind: "idle" },
        controller: null,
        controlGeneration: 0,
        renderTask: Promise.resolve(),
        stream: new BrowserScreencast({
          currentTab: () =>
            created.activeTabId ? created.tabs.get(created.activeTabId) : undefined,
          closed: () => this.closing || created.lifetime.signal.aborted,
        }),
        opening: new Set(),
        agentActions: new Set(),
      };
      workspace = created;
      this.workspaces.set(key, workspace);
    }
    return workspace;
  }

  async state(scope: BrowserScope, viewerId?: string): Promise<BrowserState> {
    await this.authorize(scope);
    const workspace = this.workspace(scope);
    const state = this.snapshot(workspace, viewerId);
    this.discardEmpty(workspace);
    return state;
  }

  private snapshot(workspace: Workspace, viewerId?: string): BrowserState {
    const tab = workspace.activeTabId ? workspace.tabs.get(workspace.activeTabId) : undefined;
    return {
      keyboardCommands: true,
      phase: workspace.phase,
      tabs: [...workspace.tabs.values()].map((tab) => ({ ...tab.state })),
      activeTabId: workspace.activeTabId,
      control:
        workspace.controller === null
          ? "available"
          : workspace.controller === "agent"
            ? "agent"
            : workspace.controller === viewerId
              ? "you"
              : "another-viewer",
      fileChooser: tab?.chooser
        ? { id: tab.chooser.id, tabId: tab.state.id, multiple: tab.chooser.multiple }
        : null,
      downloads: [...workspace.tabs.values()]
        .flatMap((tab) =>
          [...tab.downloads].map(([id, entry]) => ({
            id,
            tabId: tab.state.id,
            name: entry.name,
            size: entry.size,
            status: entry.status,
          })),
        )
        .slice(-12),
      dialog: tab?.dialog
        ? {
            id: tab.dialog.id,
            type: tab.dialog.value.type(),
            message: tab.dialog.value.message().slice(0, 4000),
            defaultValue: tab.dialog.value.defaultValue().slice(0, 4000),
          }
        : null,
    };
  }

  private broadcast(workspace: Workspace) {
    for (const viewer of workspace.stream.viewers)
      viewer.send({ kind: "state", state: this.snapshot(workspace, viewer.id) });
  }

  private setController(workspace: Workspace, controller: string | null) {
    if (workspace.controller === controller) return;
    workspace.controller = controller;
    workspace.controlGeneration++;
  }

  private invalidateView(workspace: Workspace, tab: Tab) {
    tab.state.viewId = randomUUID();
    void this.releaseKeys(workspace, tab.state.id);
    workspace.stream.invalidate();
    this.broadcast(workspace);
  }

  private withRenderLock<T>({ workspace, run }: { workspace: Workspace; run(): Promise<T> }) {
    const operation = workspace.renderTask.then(() => {
      workspace.lifetime.signal.throwIfAborted();
      return run();
    });
    workspace.renderTask = operation.then(ignored, ignored);
    return operation;
  }

  private discardEmpty(workspace: Workspace) {
    if (workspace.tabs.size || workspace.opening.size || workspace.stream.viewers.size) return;
    if (this.workspaces.get(scopeKey(workspace.scope)) !== workspace) return;
    this.workspaces.delete(scopeKey(workspace.scope));
    if (workspace.context) this.cleanup(workspace.context.then((context) => context.close()));
    if (workspace.downloadSession) this.cleanup(workspace.downloadSession.detach());
    if (workspace.downloadsDirectory)
      this.cleanup(rm(workspace.downloadsDirectory, { recursive: true, force: true }));
  }

  private async context(workspace: Workspace) {
    let opened: BrowserContext | undefined;
    workspace.context ??= (async () => {
      workspace.phase = { kind: "starting" };
      this.broadcast(workspace);
      const browser = await this.runtime.get();
      if (this.closing) throw new Error("The browser is closing.");
      workspace.lifetime.signal.throwIfAborted();
      const context = await browser.createBrowserContext();
      opened = context;
      workspace.downloadsDirectory = await mkdtemp(join(tmpdir(), "tidy-browser-downloads-"));
      const downloads = await browser.target().createCDPSession();
      workspace.downloadSession = downloads;
      await downloads.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        browserContextId: context.id,
        downloadPath: workspace.downloadsDirectory,
        eventsEnabled: true,
      });
      downloads.on("Browser.downloadWillBegin", (event) => {
        const tab = [...workspace.tabs.values()].find((tab) => tab.frameIds.has(event.frameId));
        if (!tab || !workspace.downloadsDirectory) {
          if (
            [...this.workspaces.values()].some(
              (other) =>
                other !== workspace &&
                [...other.tabs.values()].some((tab) => tab.frameIds.has(event.frameId)),
            )
          )
            return;
          void downloads
            .send("Browser.cancelDownload", { guid: event.guid, browserContextId: context.id })
            .catch(ignored);
          return;
        }
        if (
          [...workspace.tabs.values()].reduce((total, tab) => total + tab.downloads.size, 0) >= 12
        ) {
          tab.state.error = "Download storage is full. Close a preview tab to free space.";
          this.broadcast(workspace);
          void downloads
            .send("Browser.cancelDownload", { guid: event.guid, browserContextId: context.id })
            .catch(ignored);
          return;
        }
        tab.state.error = null;
        tab.state.loading = false;
        tab.downloads.set(event.guid, {
          name:
            basename(event.suggestedFilename)
              .replace(/[\x00-\x1f]/g, "")
              .slice(0, 200) || "download",
          size: 0,
          status: "pending",
          path: join(workspace.downloadsDirectory, event.guid),
        });
        this.broadcast(workspace);
      });
      downloads.on("Browser.downloadProgress", (event) => {
        const tab = [...workspace.tabs.values()].find((tab) => tab.downloads.has(event.guid));
        const entry = tab?.downloads.get(event.guid);
        if (!entry || entry.status === "failed") return;
        entry.size = event.receivedBytes;
        if (event.receivedBytes > 16 * 1024 * 1024 || event.totalBytes > 16 * 1024 * 1024) {
          entry.status = "failed";
          void downloads
            .send("Browser.cancelDownload", { guid: event.guid, browserContextId: context.id })
            .catch(ignored);
        } else if (event.state === "completed") entry.status = "ready";
        else if (event.state === "canceled") entry.status = "failed";
        this.broadcast(workspace);
      });
      context.on("targetcreated", (target) => {
        if (target.type() !== "page" || !target.opener()) return;
        void target
          .page()
          .then(async (page) => {
            if (!page) return;
            if (
              workspace.tabs.size + workspace.opening.size >= 12 ||
              this.activeCount >= 48 ||
              this.closing
            ) {
              await page.close();
              return;
            }
            const id = randomUUID();
            workspace.opening.add(id);
            try {
              await this.registerTab({ workspace, page, id });
            } finally {
              workspace.opening.delete(id);
              this.discardEmpty(workspace);
            }
          })
          .catch(ignored);
      });
      return context;
    })().catch(async (error: unknown) => {
      await opened?.close().catch(ignored);
      if (workspace.downloadSession) await workspace.downloadSession.detach().catch(ignored);
      if (workspace.downloadsDirectory)
        await rm(workspace.downloadsDirectory, { recursive: true, force: true });
      workspace.downloadSession = undefined;
      workspace.downloadsDirectory = undefined;
      workspace.context = undefined;
      workspace.phase = { kind: "error", message: errorMessage(error) };
      this.broadcast(workspace);
      throw error;
    });
    return workspace.context;
  }

  private async registerTab({
    workspace,
    page,
    id,
  }: {
    workspace: Workspace;
    page: Page;
    id: string;
  }) {
    try {
      return await this.initializeTab({ workspace, page, id });
    } catch (error) {
      await page.close().catch(ignored);
      throw error;
    }
  }

  private async initializeTab({
    workspace,
    page,
    id,
  }: {
    workspace: Workspace;
    page: Page;
    id: string;
  }) {
    if (this.closing || workspace.lifetime.signal.aborted) {
      await page.close();
      throw new Error("The browser is closing.");
    }
    const cdp = await page.createCDPSession();
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const frameIds = new Set<string>();
    const collectFrames = (tree: typeof frameTree) => {
      frameIds.add(tree.frame.id);
      for (const child of tree.childFrames ?? []) collectFrames(child);
    };
    collectFrames(frameTree);
    const tab: Tab = {
      page,
      cdp,
      console: [],
      dialog: null,
      navigation: 0,
      frameId: frameTree.frame.id,
      frameIds,
      chooser: null,
      uploads: [],
      uploadBytes: 0,
      uploadBatches: 0,
      downloads: new Map(),
      state: {
        id,
        viewId: randomUUID(),
        url: page.url(),
        title: "New tab",
        loading: false,
        error: null,
        canGoBack: false,
        canGoForward: false,
        width: 1280,
        height: 800,
      },
    };
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(20000);
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await cdp.send("Fetch.enable", {
      patterns: ["file:*", "chrome:*", "devtools:*", "chrome-extension:*"].map((urlPattern) => ({
        urlPattern,
      })),
    });
    cdp.on("Fetch.requestPaused", (request) => {
      void cdp
        .send("Fetch.failRequest", { requestId: request.requestId, errorReason: "BlockedByClient" })
        .catch(ignored);
    });
    const update = async () => {
      if (page.isClosed()) return;
      try {
        const viewId = tab.state.viewId;
        const history = await cdp.send("Page.getNavigationHistory");
        const title = (await page.title()).slice(0, 500) || "Untitled";
        if (viewId !== tab.state.viewId) return;
        tab.state = {
          ...tab.state,
          url: page.url().slice(0, 8192),
          title,
          canGoBack: history.currentIndex > 0,
          canGoForward: history.currentIndex < history.entries.length - 1,
        };
        this.broadcast(workspace);
      } catch {}
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) void update();
    });
    const loaded = () => {
      tab.state.loading = false;
      workspace.stream.refresh();
      void update();
    };
    page.on("domcontentloaded", loaded);
    page.on("load", loaded);
    page.on("console", (message) => {
      tab.console.push(`${message.type()}: ${message.text().slice(0, 2000)}`);
      if (tab.console.length > 200) tab.console.shift();
    });
    page.on("pageerror", (error) => {
      tab.console.push(`error: ${String(error).slice(0, 2000)}`);
      if (tab.console.length > 200) tab.console.shift();
    });
    cdp.on("Page.frameAttached", ({ frameId }) => tab.frameIds.add(frameId));
    cdp.on("Page.frameDetached", ({ frameId, reason }) => {
      if (reason !== "swap") tab.frameIds.delete(frameId);
    });
    cdp.on("Page.frameNavigated", ({ frame }) => {
      tab.frameIds.add(frame.id);
      if (frame.parentId) return;
      tab.frameId = frame.id;
      tab.state = {
        ...tab.state,
        url: frame.url.slice(0, 8192),
        loading: true,
      };
      tab.chooser = null;
      this.invalidateView(workspace, tab);
      workspace.stream.refresh();
    });
    cdp.on("Page.navigatedWithinDocument", ({ frameId, url, navigationType }) => {
      if (frameId !== tab.frameId || navigationType !== "historyApi") return;
      tab.state.url = url.slice(0, 8192);
      this.invalidateView(workspace, tab);
      workspace.stream.refresh();
    });
    await cdp.send("Page.enable");
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
    cdp.on("Page.fileChooserOpened", (event) => {
      if (typeof event.backendNodeId !== "number") return;
      tab.chooser = {
        id: randomUUID(),
        backendNodeId: event.backendNodeId,
        multiple: event.mode === "selectMultiple",
      };
      this.broadcast(workspace);
    });
    page.on("dialog", (dialog) => {
      tab.dialog = { id: randomUUID(), value: dialog };
      this.broadcast(workspace);
    });
    page.on("error", () => {
      tab.state.error = "This page crashed. Reload it to continue.";
      this.broadcast(workspace);
    });
    page.once("close", () => {
      for (const directory of tab.uploads)
        this.cleanup(rm(directory, { recursive: true, force: true }));
      for (const [guid, entry] of tab.downloads) {
        const cancelled =
          entry.status === "pending"
            ? workspace.downloadSession
                ?.send("Browser.cancelDownload", {
                  guid,
                  browserContextId: page.browserContext().id,
                })
                .catch(ignored)
            : undefined;
        this.cleanup(
          Promise.resolve(cancelled).then(() =>
            Promise.all([
              rm(entry.path, { force: true }),
              rm(`${entry.path}.crdownload`, { force: true }),
            ]),
          ),
        );
      }
      this.pressedKeys.delete(id);
      this.pressedButtons.delete(id);
      tab.navigationController?.abort();
      workspace.tabs.delete(id);
      if (workspace.activeTabId === id)
        workspace.activeTabId = [...workspace.tabs.keys()].at(-1) ?? null;
      if (!workspace.tabs.size) {
        workspace.phase = { kind: "idle" };
        this.setController(workspace, null);
      }
      this.broadcast(workspace);
      workspace.stream.refresh();
      this.discardEmpty(workspace);
    });
    if (page.isClosed() || this.closing || workspace.lifetime.signal.aborted)
      throw new Error("The browser tab closed while opening.");
    workspace.tabs.set(id, tab);
    workspace.opening.delete(id);
    workspace.activeTabId = id;
    workspace.phase = { kind: "ready" };
    void update();
    this.broadcast(workspace);
    workspace.stream.refresh();
    return tab;
  }

  async command(
    scope: BrowserScope,
    action: BrowserAction,
    { actor = "agent", signal: requestSignal }: { actor?: string; signal?: AbortSignal } = {},
  ): Promise<BrowserResult> {
    requestSignal?.throwIfAborted();
    await this.authorize(scope);
    requestSignal?.throwIfAborted();
    const workspace = this.workspace(scope);
    const readOnly = isBrowserQuery(action);
    if (!readOnly && workspace.controller && workspace.controller !== actor)
      throw new Error(
        workspace.controller === "agent"
          ? "The agent is using this browser. Take control first."
          : "A viewer has control. Release control before the agent continues.",
      );
    if (actor === "agent" && !readOnly) {
      this.setController(workspace, "agent");
      this.broadcast(workspace);
    }
    if (actor !== "agent" && !readOnly) {
      this.setController(workspace, actor);
      this.broadcast(workspace);
    }
    const operation = new AbortController();
    if (actor === "agent" && !readOnly) workspace.agentActions.add(operation);
    const signal = AbortSignal.any([
      operation.signal,
      workspace.lifetime.signal,
      ...(requestSignal ? [requestSignal] : []),
    ]);
    const controlGeneration = workspace.controlGeneration;
    const assertControl = () => {
      signal.throwIfAborted();
      if (workspace.controller !== actor || workspace.controlGeneration !== controlGeneration)
        throw new Error("Browser control changed before the action could complete.");
    };
    let output: string | undefined;
    try {
      if (action.kind === "open") {
        const url = browserURL(action.url);
        if (this.activeCount >= 48)
          throw new Error(
            "Close an unused browser tab before opening more. Up to 48 tabs can run on this host.",
          );
        if (workspace.tabs.size + workspace.opening.size >= 12)
          throw new Error(
            "Close a tab before opening another. Each thread supports up to 12 tabs.",
          );
        const id = randomUUID();
        workspace.opening.add(id);
        try {
          const context = await this.context(workspace);
          signal.throwIfAborted();
          const tab = await this.registerTab({ workspace, page: await context.newPage(), id });
          signal.throwIfAborted();
          await this.navigate(workspace, tab, url, signal);
        } finally {
          workspace.opening.delete(id);
          this.discardEmpty(workspace);
        }
      } else {
        const tab = workspace.tabs.get(action.tabId);
        if (!tab || tab.page.isClosed()) throw new Error("This browser tab is no longer open.");
        switch (action.kind) {
          case "upload": {
            assertControl();
            const chooser = tab.chooser;
            if (!chooser || chooser.id !== action.chooserId)
              throw new Error("This file picker is no longer open.");
            if (!chooser.multiple && action.files.length > 1)
              throw new Error("This page accepts one file.");
            const size = action.files.reduce(
              (total, file) => total + Buffer.byteLength(file.data, "base64"),
              0,
            );
            if (size > 16 * 1024 * 1024) throw new Error("Choose files totalling at most 16 MB.");
            if (action.files.length === 0) {
              await tab.cdp.send("DOM.setFileInputFiles", {
                backendNodeId: chooser.backendNodeId,
                files: [],
              });
              if (tab.chooser?.id === chooser.id) tab.chooser = null;
              break;
            }
            const staged = [...workspace.tabs.values()];
            if (
              staged.reduce((total, tab) => total + tab.uploadBytes, size) > 64 * 1024 * 1024 ||
              staged.reduce((total, tab) => total + tab.uploadBatches, 0) >= 32
            )
              throw new Error("Upload storage is full. Close a preview tab to free space.");
            tab.uploadBytes += size;
            tab.uploadBatches++;
            let directory: string | undefined;
            let completed = false;
            try {
              directory = await mkdtemp(join(tmpdir(), "tidy-browser-upload-"));
              tab.uploads.push(directory);
              const paths: string[] = [];
              for (const [index, file] of action.files.entries()) {
                assertControl();
                if (tab.page.isClosed()) throw new Error("This browser tab is no longer open.");
                const folder = join(directory, String(index));
                await mkdir(folder, { mode: 0o700 });
                assertControl();
                const name = basename(file.name.replaceAll("\\", "/")).replace(/[\x00-\x1f]/g, "");
                if (!name || name === "." || name === "..") throw new Error("Invalid file name.");
                const path = join(folder, name);
                await writeFile(path, Buffer.from(file.data, "base64"), { mode: 0o600 });
                paths.push(path);
              }
              if (tab.page.isClosed() || tab.chooser?.id !== chooser.id)
                throw new Error("This file picker is no longer open.");
              assertControl();
              await tab.cdp.send("DOM.setFileInputFiles", {
                backendNodeId: chooser.backendNodeId,
                files: paths,
              });
              if (tab.page.isClosed()) throw new Error("This browser tab is no longer open.");
              if (tab.chooser?.id === chooser.id) tab.chooser = null;
              completed = true;
            } finally {
              if (!completed) {
                tab.uploadBytes -= size;
                tab.uploadBatches--;
                if (directory) {
                  tab.uploads = tab.uploads.filter((path) => path !== directory);
                  await rm(directory, { recursive: true, force: true });
                }
              }
            }
            break;
          }
          case "download": {
            const entry = tab.downloads.get(action.downloadId);
            if (!entry || entry.status !== "ready")
              throw new Error("This download is not available.");
            if ((await stat(entry.path)).size > 16 * 1024 * 1024)
              throw new Error("Downloads are limited to 16 MB.");
            output = (await readFile(entry.path)).toString("base64");
            break;
          }
          case "select":
            await this.releaseKeys(workspace);
            workspace.activeTabId = action.tabId;
            workspace.stream.refresh();
            break;
          case "close":
            await this.releaseKeys(workspace, tab.state.id);
            await tab.page.close();
            break;
          case "navigate":
            await this.navigate(workspace, tab, browserURL(action.url), signal);
            break;
          case "back":
          case "forward":
          case "reload":
            await this.navigate(workspace, tab, action, signal);
            break;
          case "stop":
            tab.navigationController?.abort();
            await tab.cdp.send("Page.stopLoading");
            tab.state.loading = false;
            break;
          case "find": {
            const result = await tab.cdp.send("Runtime.evaluate", {
              expression: `window.find(${JSON.stringify(action.text)},false,${action.backwards},true)`,
              returnByValue: true,
              timeout: 1000,
            });
            if (result.exceptionDetails) throw new Error("Find is unavailable on this page.");
            output = JSON.stringify(result.result.value === true);
            break;
          }
          case "console":
            output = tab.console.join("\n");
            break;
          case "snapshot": {
            const tree = await tab.cdp.send("Accessibility.getFullAXTree");
            output = JSON.stringify(
              tree.nodes
                .filter((node) => !node.ignored)
                .slice(0, 500)
                .map((node) => ({
                  role: node.role?.value,
                  name: node.name?.value,
                  value: node.value?.value,
                  backendNodeId: node.backendDOMNodeId,
                })),
            );
            break;
          }
          case "screenshot": {
            output = await this.withRenderLock({
              workspace,
              run: async () => {
                signal.throwIfAborted();
                return workspace.stream.pauseWhile({
                  run: async () => {
                    signal.throwIfAborted();
                    return Buffer.from(
                      await tab.page.screenshot({ type: "jpeg", quality: 80 }),
                    ).toString("base64");
                  },
                });
              },
            });
            break;
          }
          case "evaluate": {
            const result = await tab.cdp.send("Runtime.evaluate", {
              expression: action.expression,
              returnByValue: true,
              awaitPromise: true,
              timeout: 8000,
            });
            signal.throwIfAborted();
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
            output = JSON.stringify(result.result.value) ?? "null";
            break;
          }
          case "click":
            await tab.page.locator(action.selector).click({ signal });
            break;
          case "fill":
            await tab.page.locator(action.selector).fill(action.text, { signal });
            break;
          default: {
            const exhaustive: never = action;
            throw new Error(String(exhaustive));
          }
        }
      }
    } finally {
      workspace.agentActions.delete(operation);
      if (
        actor === "agent" &&
        workspace.controller === "agent" &&
        workspace.agentActions.size === 0
      )
        this.setController(workspace, null);
      if (!readOnly) this.broadcast(workspace);
      this.discardEmpty(workspace);
    }
    return {
      state: this.snapshot(workspace, actor),
      ...(output === undefined
        ? {}
        : { output: output.slice(0, (action.kind === "download" ? 22 : 8) * 1024 * 1024) }),
    };
  }

  private async navigate(
    workspace: Workspace,
    tab: Tab,
    destination: string | Extract<BrowserAction, { kind: "back" | "forward" | "reload" }>,
    signal: AbortSignal,
  ) {
    tab.navigationController?.abort();
    tab.navigationController = new AbortController();
    const navigation = ++tab.navigation;
    if (typeof destination === "string") tab.state.url = destination;
    tab.state.loading = true;
    tab.state.error = null;
    this.broadcast(workspace);
    const navigationSignal = AbortSignal.any([signal, tab.navigationController.signal]);
    const options = { waitUntil: "domcontentloaded" as const, signal: navigationSignal };
    try {
      if (typeof destination === "string") await tab.page.goto(destination, options);
      else if (destination.kind === "back") await tab.page.goBack(options);
      else if (destination.kind === "forward") await tab.page.goForward(options);
      else await tab.page.reload({ ...options, ignoreCache: destination.ignoreCache });
    } catch (error) {
      if (navigation === tab.navigation && !navigationSignal.aborted)
        tab.state.error = errorMessage(error);
    } finally {
      if (navigation === tab.navigation) {
        tab.state.loading = false;
        this.broadcast(workspace);
      }
    }
  }

  async watch(scope: BrowserScope, id: string, send: BrowserViewer["send"]): Promise<BrowserWatch> {
    await this.authorize(scope);
    const workspace = this.workspace(scope);
    if (workspace.stream.viewers.size >= 8) throw new Error("Too many viewers for this browser.");
    const viewer: BrowserViewer = {
      id,
      send,
      visible: true,
      inflight: new Set(),
      closed: false,
      view: null,
    };
    workspace.stream.viewers.add(viewer);
    viewer.send({ kind: "state", state: this.snapshot(workspace, id) });
    workspace.stream.refresh();
    let queued = Promise.resolve();
    let pendingInputs = 0;
    const answeringDialogs = new Set<string>();
    return {
      input: ({ input, tabId, viewId }) => {
        if (viewer.closed) return;
        if (input.kind === "ack") {
          workspace.stream.acknowledge(viewer, input.frameId);
          return;
        }
        if (input.kind === "take-control") {
          for (const action of workspace.agentActions)
            action.abort(new Error("A viewer took control of this browser."));
          this.setController(workspace, id);
          void this.releaseKeys(workspace);
          this.broadcast(workspace);
          return;
        }
        if (input.kind === "release-control") {
          if (workspace.controller === id) {
            this.setController(workspace, null);
            void this.releaseKeys(workspace);
            this.broadcast(workspace);
          }
          return;
        }
        if (input.kind === "visibility") {
          if (viewer.visible === input.visible) return;
          viewer.visible = input.visible;
          viewer.view = null;
          viewer.pending = undefined;
          viewer.inflight.clear();
          if (!input.visible && workspace.controller === id) {
            this.setController(workspace, null);
            void this.releaseKeys(workspace);
            this.broadcast(workspace);
          }
          workspace.stream.refresh();
          return;
        }
        const controlGeneration = workspace.controlGeneration;
        const dispatch = async () => {
          if (
            viewer.closed ||
            workspace.lifetime.signal.aborted ||
            workspace.controller !== id ||
            controlGeneration !== workspace.controlGeneration
          )
            return;
          await this.authorize(scope);
          if (
            viewer.closed ||
            workspace.lifetime.signal.aborted ||
            workspace.controller !== id ||
            controlGeneration !== workspace.controlGeneration
          )
            return;
          if (
            ["mouse", "wheel", "key", "text"].includes(input.kind) &&
            workspace.tabs.get(tabId ?? "")?.state.viewId !== viewId
          )
            return;
          await this.dispatch(
            workspace,
            input,
            tabId,
            () =>
              !viewer.closed &&
              !workspace.lifetime.signal.aborted &&
              workspace.controller === id &&
              controlGeneration === workspace.controlGeneration,
          );
        };
        const failed = (error: unknown) => {
          if (!viewer.closed) send({ kind: "error", message: errorMessage(error) });
        };
        if (input.kind === "dialog") {
          if (
            answeringDialogs.has(input.dialogId) ||
            workspace.tabs.get(tabId ?? "")?.dialog?.id !== input.dialogId
          )
            return;
          answeringDialogs.add(input.dialogId);
          void dispatch()
            .catch(failed)
            .finally(() => answeringDialogs.delete(input.dialogId));
          return;
        }
        if (pendingInputs >= 64) {
          this.setController(workspace, null);
          void this.releaseKeys(workspace);
          this.broadcast(workspace);
          send({ kind: "error", message: "Browser input fell behind. Take control to continue." });
          return;
        }
        pendingInputs++;
        queued = queued
          .then(dispatch)
          .catch(failed)
          .finally(() => {
            pendingInputs--;
          });
      },
      close: () => {
        viewer.closed = true;
        workspace.stream.viewers.delete(viewer);
        workspace.stream.refresh();
        this.discardEmpty(workspace);
        if (workspace.controller === id) {
          this.setController(workspace, null);
          void this.releaseKeys(workspace);
          this.broadcast(workspace);
        }
      },
    };
  }

  private pressedKeys = new Map<string, Map<string, { key: string; code: string }>>();
  private pressedButtons = new Map<string, Set<"left" | "middle" | "right">>();

  private async releaseKeys(workspace: Workspace, tabId?: string) {
    for (const tab of workspace.tabs.values()) {
      if (tabId && tab.state.id !== tabId) continue;
      const keys = this.pressedKeys.get(tab.state.id);
      const buttons = this.pressedButtons.get(tab.state.id);
      this.pressedKeys.delete(tab.state.id);
      this.pressedButtons.delete(tab.state.id);
      await Promise.all([
        ...[...(keys?.values() ?? [])].map((value) =>
          tab.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...value }).catch(ignored),
        ),
        ...[...(buttons ?? [])].map((button) =>
          tab.cdp
            .send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: 0,
              y: 0,
              button,
              buttons: 0,
            })
            .catch(ignored),
        ),
      ]);
    }
  }

  private async dispatch(
    workspace: Workspace,
    input: BrowserInput,
    tabId: string | null,
    stillControls: () => boolean,
  ) {
    if (input.kind === "release-keys") {
      await this.releaseKeys(workspace, tabId ?? undefined);
      return;
    }
    if (tabId !== workspace.activeTabId) return;
    const tab = tabId ? workspace.tabs.get(tabId) : undefined;
    if (!tab) return;
    const modifiers =
      "modifiers" in input && process.platform !== "darwin" && input.modifiers & 4
        ? (input.modifiers & ~4) | 2
        : "modifiers" in input
          ? input.modifiers
          : 0;
    switch (input.kind) {
      case "mouse": {
        if (input.button !== "none") {
          let buttons = this.pressedButtons.get(tab.state.id);
          if (!buttons) {
            buttons = new Set();
            this.pressedButtons.set(tab.state.id, buttons);
          }
          if (input.action === "down") buttons.add(input.button);
          if (input.action === "up") buttons.delete(input.button);
        }
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type:
            input.action === "down"
              ? "mousePressed"
              : input.action === "up"
                ? "mouseReleased"
                : "mouseMoved",
          x: input.x,
          y: input.y,
          button: input.button,
          buttons: input.buttons,
          modifiers,
          clickCount: input.clickCount,
        });
        break;
      }
      case "wheel":
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          modifiers,
        });
        break;
      case "key": {
        let keys = this.pressedKeys.get(tab.state.id);
        if (!keys) {
          keys = new Map();
          this.pressedKeys.set(tab.state.id, keys);
        }
        if (input.action === "up") keys.delete(input.code);
        else keys.set(input.code, { key: input.key, code: input.code });
        await tab.cdp.send("Input.dispatchKeyEvent", {
          type: input.action === "up" ? "keyUp" : input.text ? "keyDown" : "rawKeyDown",
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.keyCode,
          commands: input.action === "down" && input.command ? [input.command] : undefined,
          text: input.text,
          modifiers,
        });
        break;
      }
      case "text":
        await tab.cdp.send("Input.insertText", { text: input.text });
        break;
      case "resize":
        await this.withRenderLock({
          workspace,
          run: async () => {
            if (
              !stillControls() ||
              workspace.activeTabId !== tabId ||
              (tab.state.width === input.width && tab.state.height === input.height)
            )
              return;
            await this.releaseKeys(workspace);
            if (!stillControls() || workspace.activeTabId !== tabId) return;
            this.invalidateView(workspace, tab);
            try {
              await tab.page.setViewport({
                width: input.width,
                height: input.height,
                deviceScaleFactor: 1,
              });
              tab.state.width = input.width;
              tab.state.height = input.height;
            } finally {
              this.broadcast(workspace);
              workspace.stream.refresh();
            }
          },
        });
        break;
      case "dialog":
        if (tab.dialog?.id === input.dialogId) {
          const dialog = tab.dialog.value;
          tab.dialog = null;
          if (input.accept) await dialog.accept(input.text);
          else await dialog.dismiss();
          this.broadcast(workspace);
        }
        break;
      case "ack":
      case "take-control":
      case "release-control":
      case "visibility":
        break;
      default: {
        const exhaustive: never = input;
        throw new Error(String(exhaustive));
      }
    }
  }

  async discardDraft(scope: BrowserScope) {
    await this.authorize(scope);
    const workspace = this.workspaces.get(scopeKey(scope));
    if (workspace)
      await this.removeWorkspaces(
        [workspace],
        "This preview was closed because its draft could not start.",
      );
  }

  async removeProject(projectId: string) {
    const workspaces = [...this.workspaces.values()].filter(
      (workspace) => workspace.scope.projectId === projectId,
    );
    await this.removeWorkspaces(
      workspaces,
      "This project's browser was closed because the project was removed.",
    );
  }

  private async removeWorkspaces(workspaces: Workspace[], message: string) {
    for (const workspace of workspaces) {
      workspace.lifetime.abort(new Error(message));
      workspace.stream.invalidate();
      this.workspaces.delete(scopeKey(workspace.scope));
      const directories = [...workspace.tabs.values()].flatMap((tab) => tab.uploads);
      if (workspace.downloadsDirectory) directories.push(workspace.downloadsDirectory);
      workspace.tabs.clear();
      workspace.activeTabId = null;
      workspace.phase = { kind: "error", message };
      this.setController(workspace, null);
      this.broadcast(workspace);
      for (const viewer of workspace.stream.viewers) viewer.closed = true;
      workspace.stream.viewers.clear();
      await workspace.stream.close();
      await workspace.context?.then((context) => context.close()).catch(ignored);
      await workspace.downloadSession?.detach().catch(ignored);
      await Promise.allSettled(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
      );
    }
  }

  cancelAgent(scope: BrowserScope) {
    const workspace = this.workspaces.get(scopeKey(scope));
    if (!workspace) return;
    for (const action of workspace.agentActions) action.abort(new Error("The agent run ended."));
    if (workspace.controller === "agent") {
      this.setController(workspace, null);
      this.broadcast(workspace);
    }
  }

  get activeCount() {
    return [...this.workspaces.values()].reduce(
      (count, workspace) => count + workspace.tabs.size + workspace.opening.size,
      0,
    );
  }

  async close() {
    this.closing = true;
    for (const workspace of this.workspaces.values()) {
      workspace.lifetime.abort(new Error("The browser is closing."));
      for (const viewer of workspace.stream.viewers) {
        viewer.closed = true;
      }
      workspace.stream.viewers.clear();
      workspace.stream.invalidate();
      this.cleanup(workspace.stream.close());
    }
    await this.runtime.close();
    for (const workspace of this.workspaces.values()) {
      for (const tab of workspace.tabs.values())
        for (const directory of tab.uploads) await rm(directory, { recursive: true, force: true });
      if (workspace.downloadsDirectory)
        await rm(workspace.downloadsDirectory, { recursive: true, force: true });
    }
    await Promise.allSettled([...this.cleanupPromises]);
    this.workspaces.clear();
  }
}

export { emptyBrowserState };
