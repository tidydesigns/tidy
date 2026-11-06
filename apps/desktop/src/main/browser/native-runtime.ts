import { join } from "node:path";
import { randomUUID, randomInt } from "node:crypto";
import { session, WebContentsView, BrowserWindow, BaseWindow, type Session } from "electron";
import type {
  BrowserNativeBounds,
  BrowserState,
  BrowserOutput,
} from "../../shared/contracts/browser";
import { connect, type Browser, type ConnectionTransport } from "puppeteer-core";

type TargetInfo = {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener: boolean;
  browserContextId?: string;
  openerId?: string;
};
type Shortcut = Extract<BrowserOutput, { kind: "shortcut" }>["action"];
type NativePage = {
  shortcut?(action: Shortcut): void;
  view: WebContentsView;
  info: TargetInfo;
  exposed: boolean;
  input: boolean;
  frameId: string;
  emulationKey?: string;
  owner?: BaseWindow;
  presenter?: { park(): void };
};
type NativeContext = {
  session: Session;
  anchor: NativePage;
  downloadPath?: string;
  downloads: Map<string, Electron.DownloadItem>;
};
type Message = { id: number; method: string; sessionId?: string; params?: Record<string, unknown> };

/** CDP stays in-process: no debugging port, renderer bridge, or second browser. */
export class NativeBrowserRuntime implements ConnectionTransport {
  readonly native = true;
  onmessage?: (message: string) => void;
  onclose?: () => void;
  private pending?: Promise<Browser>;
  private parking?: BaseWindow;
  private readonly opening = new Set<WebContentsView>();
  private readonly contexts = new Map<string, NativeContext>();
  private readonly pages = new Map<string, NativePage>();
  private readonly sessions = new Map<string, { page: NativePage; info: TargetInfo }>();
  private readonly presenters = new Map<number, () => void>();
  private readonly browserSessions = new Set<string>();
  private discovering = false;
  private attaching = false;
  private closed = false;
  private readonly browserInfo: TargetInfo = {
    targetId: "native-browser",
    type: "browser",
    title: "Tidy browser",
    url: "",
    attached: true,
    canAccessOpener: false,
  };

  get() {
    if (this.closed) throw new Error("The browser is closing.");
    return (this.pending ??= connect({ transport: this, defaultViewport: null }));
  }

  private emit(message: object) {
    // Match an asynchronous CDP transport without a timer in the input/render path.
    queueMicrotask(() => {
      if (!this.closed) this.onmessage?.(JSON.stringify(message));
    });
  }

  send(raw: string) {
    const message = JSON.parse(raw) as Message;
    if (
      !message ||
      !Number.isSafeInteger(message.id) ||
      typeof message.method !== "string" ||
      (message.sessionId !== undefined && typeof message.sessionId !== "string") ||
      (message.params !== undefined &&
        (!message.params || typeof message.params !== "object" || Array.isArray(message.params)))
    )
      throw new Error("Invalid native browser protocol message.");
    void this.command(message).then(
      (result) => this.emit({ id: message.id, sessionId: message.sessionId, result }),
      (error: unknown) =>
        this.emit({
          id: message.id,
          sessionId: message.sessionId,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : "Native browser command failed.",
          },
        }),
    );
  }

  private createView(partition: Session, options: Electron.BrowserWindowConstructorOptions = {}) {
    const view = new WebContentsView({
      ...options,
      webPreferences: {
        ...options.webPreferences,
        preload: undefined,
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        backgroundThrottling: true,
      },
    });
    view.webContents.setZoomMode("isolated");
    return view;
  }

  private async createPage(
    partition: Session,
    openerId?: string,
    view = this.createView(partition),
  ) {
    if (this.closed) {
      view.webContents.close();
      throw new Error("The browser is closing.");
    }
    this.opening.add(view);
    try {
      view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
      this.parking ??= new BaseWindow({ show: false, width: 1280, height: 800 });
      this.parking.contentView.addChildView(view);
      const contents = view.webContents;
      const allowed = (url: string) => /^(https?:\/\/|about:blank$)/i.test(url);
      contents.on("will-frame-navigate", (event) => {
        if (!allowed(event.url)) event.preventDefault();
      });
      contents.on("will-redirect", (event) => {
        if (!allowed(event.url)) event.preventDefault();
      });
      // Popup contents are created here with the same isolated session and secure preferences.
      contents.setWindowOpenHandler((details) => {
        if (!allowed(details.url)) return { action: "deny" };
        return {
          action: "allow",
          createWindow: (options) => {
            // Electron requires synchronous WebContents creation; adopt it before any navigation.
            const popup = this.createView(partition, options);
            void this.createPage(partition, page.info.targetId, popup)
              .then((created) => this.expose(created))
              .catch(() => {
                if (!popup.webContents.isDestroyed()) popup.webContents.close();
              });
            return popup.webContents;
          },
        };
      });
      if (!openerId) await contents.loadURL("about:blank");
      contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      const { targetInfo } = (await contents.debugger.sendCommand("Target.getTargetInfo")) as {
        targetInfo: TargetInfo;
      };
      const { frameTree } = await contents.debugger.sendCommand("Page.getFrameTree");
      const page: NativePage = {
        frameId: frameTree.frame.id,
        view,
        info: { ...targetInfo, ...(openerId ? { openerId } : {}) },
        exposed: false,
        input: false,
        owner: this.parking,
      };
      this.pages.set(page.info.targetId, page);
      contents.on("before-input-event", (event, input) => {
        if (!page.input || input.type !== "keyDown") return;
        const command = process.platform === "darwin" ? input.meta : input.control;
        const key = input.key.toLowerCase();
        const action: Shortcut | undefined =
          command && !input.alt
            ? key === "l"
              ? "address"
              : key === "f"
                ? "find"
                : key === "r"
                  ? input.shift
                    ? "reload-ignore-cache"
                    : "reload"
                  : key === "["
                    ? "back"
                    : key === "]"
                      ? "forward"
                      : undefined
            : input.alt && !command
              ? key === "arrowleft"
                ? "back"
                : key === "arrowright"
                  ? "forward"
                  : undefined
              : undefined;
        if (action) {
          event.preventDefault();
          page.shortcut?.(action);
        }
      });

      contents.debugger.on(
        "message",
        (_event, method, params: Record<string, unknown>, sessionId) => {
          if (sessionId && this.sessions.get(sessionId)?.page !== page) return;
          if (method === "Page.frameNavigated" && !(params.frame as { parentId?: string }).parentId)
            page.frameId = (params.frame as { id: string }).id;
          if (method === "Target.attachedToTarget") {
            const info = params.targetInfo as TargetInfo;
            // Only Chromium's children of this debugger may extend its session tree.
            // Manual attachment is checked below before Chromium receives the request.
            if (
              info.targetId !== page.info.targetId &&
              (!sessionId ||
                !["iframe", "worker", "shared_worker", "service_worker"].includes(info.type) ||
                (info.browserContextId && info.browserContextId !== page.info.browserContextId))
            ) {
              void contents.debugger
                .sendCommand("Target.detachFromTarget", { sessionId: params.sessionId })
                .catch(() => {});
              return;
            }
            this.sessions.set(params.sessionId as string, { page, info });
          }
          if (method === "Target.detachedFromTarget")
            this.sessions.delete(params.sessionId as string);
          if (method === "Target.targetInfoChanged") {
            const info = params.targetInfo as TargetInfo;
            let known = info.targetId === page.info.targetId;
            for (const target of this.sessions.values())
              if (target.page === page && target.info.targetId === info.targetId) {
                target.info = info;
                known = true;
              }
            if (known) this.emit({ method, params });
            return;
          }
          // Root discovery must never reveal the trusted app or another browser runtime.
          if (
            !sessionId &&
            method.startsWith("Target.") &&
            method !== "Target.attachedToTarget" &&
            method !== "Target.detachedFromTarget"
          )
            return;
          if (method.startsWith("Browser.")) {
            for (const id of this.browserSessions) this.emit({ method, params, sessionId: id });
          } else this.emit({ method, params, ...(sessionId ? { sessionId } : {}) });
        },
      );
      const update = () => {
        page.info = { ...page.info, url: contents.getURL(), title: contents.getTitle() };
        if (page.exposed)
          this.emit({ method: "Target.targetInfoChanged", params: { targetInfo: page.info } });
      };
      contents.on("did-navigate", update);
      contents.on("did-navigate-in-page", update);
      contents.on("page-title-updated", update);
      contents.debugger.on("detach", () => {
        if (!contents.isDestroyed() && !this.closed)
          setImmediate(() => {
            if (!contents.isDestroyed()) contents.close();
          });
      });
      contents.once("destroyed", () => {
        this.hide(page);
        this.pages.delete(page.info.targetId);
        for (const [id, owner] of this.sessions)
          if (owner.page === page) {
            this.sessions.delete(id);
            this.emit({
              method: "Target.detachedFromTarget",
              params: { sessionId: id, targetId: page.info.targetId },
            });
          }
        if (page.exposed)
          this.emit({ method: "Target.targetDestroyed", params: { targetId: page.info.targetId } });
      });
      return page;
    } catch (error) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
      throw error;
    } finally {
      this.opening.delete(view);
    }
  }

  private browserEvent(method: string, params: object) {
    for (const sessionId of this.browserSessions) this.emit({ method, params, sessionId });
  }

  private async expose(page: NativePage) {
    page.exposed = true;
    if (this.discovering)
      this.emit({ method: "Target.targetCreated", params: { targetInfo: page.info } });
    if (this.attaching)
      await page.view.webContents.debugger.sendCommand("Target.attachToTarget", {
        targetId: page.info.targetId,
        flatten: true,
      });
  }

  /** Keep global target operations in the shim and page sessions within their preview tree. */
  private async command({ method, params = {}, sessionId }: Message): Promise<unknown> {
    if (this.closed) throw new Error("The browser is closing.");
    const browserLevel = !sessionId || this.browserSessions.has(sessionId);
    if (browserLevel) {
      switch (method) {
        case "Browser.getVersion":
          return {
            protocolVersion: "1.3",
            product: `Chrome/${process.versions.chrome}`,
            revision: "",
            userAgent: "Tidy",
            jsVersion: process.versions.v8,
          };
        case "Target.getBrowserContexts":
          return { browserContextIds: [...this.contexts.keys()] };
        case "Target.getTargets":
          return {
            targetInfos: [...this.pages.values()]
              .filter((page) => page.exposed)
              .map((page) => page.info),
          };
        case "Target.setDiscoverTargets":
          this.discovering = params.discover === true;
          if (this.discovering) {
            this.emit({ method: "Target.targetCreated", params: { targetInfo: this.browserInfo } });
            for (const page of this.pages.values())
              if (page.exposed)
                this.emit({ method: "Target.targetCreated", params: { targetInfo: page.info } });
          }
          return {};
        case "Target.setAutoAttach":
          this.attaching = params.autoAttach === true;
          return {};
        case "Target.createBrowserContext": {
          const partition = session.fromPartition(`tidy-preview-${randomUUID()}`, { cache: true });
          partition.webRequest.onBeforeRequest((details, callback) => {
            callback({
              cancel: /^(file|chrome|devtools|chrome-extension|tidy):/i.test(details.url),
            });
          });
          partition.setPermissionRequestHandler((_contents, _permission, callback) =>
            callback(false),
          );
          partition.setPermissionCheckHandler(() => false);
          const anchor = await this.createPage(partition);
          const id = anchor.info.browserContextId!;
          const context: NativeContext = { session: partition, anchor, downloads: new Map() };
          this.contexts.set(id, context);
          partition.on("will-download", (_event, item, contents) => {
            if (!context.downloadPath || !contents) {
              item.cancel();
              return;
            }
            const page = [...this.pages.values()].find(
              (page) => page.view.webContents === contents,
            );
            if (!page?.exposed || !context.downloadPath) {
              item.cancel();
              return;
            }
            const guid = randomUUID();
            context.downloads.set(guid, item);
            item.setSavePath(join(context.downloadPath, guid));
            const progress = (state: string) =>
              this.browserEvent("Browser.downloadProgress", {
                guid,
                state,
                receivedBytes: item.getReceivedBytes(),
                totalBytes: item.getTotalBytes(),
              });
            this.browserEvent("Browser.downloadWillBegin", {
              guid,
              url: item.getURL(),
              suggestedFilename: item.getFilename(),
              frameId: page.frameId,
            });
            item.on("updated", () => progress("inProgress"));
            item.once("done", (_event, state) => {
              progress(state === "completed" ? "completed" : "canceled");
              context.downloads.delete(guid);
            });
          });
          return { browserContextId: id };
        }
        case "Browser.setDownloadBehavior": {
          const context = this.contexts.get(params.browserContextId as string);
          if (
            !context ||
            params.behavior !== "allowAndName" ||
            typeof params.downloadPath !== "string"
          )
            throw new Error("Invalid native download configuration.");
          context.downloadPath = params.downloadPath;
          return {};
        }
        case "Browser.cancelDownload": {
          this.contexts
            .get(params.browserContextId as string)
            ?.downloads.get(params.guid as string)
            ?.cancel();
          return {};
        }
        case "Target.disposeBrowserContext": {
          const id = params.browserContextId as string;
          for (const page of this.pages.values())
            if (page.info.browserContextId === id) page.view.webContents.close();
          const context = this.contexts.get(id);
          this.contexts.delete(id);
          if (context) {
            context.session.removeAllListeners("will-download");
            for (const item of context.downloads.values()) item.cancel();
            await Promise.all([context.session.clearStorageData(), context.session.clearCache()]);
          }
          return {};
        }
        case "Target.createTarget": {
          const context = this.contexts.get(params.browserContextId as string);
          if (!context) throw new Error("Unknown native browser context.");
          const page =
            !context.anchor.exposed && !context.anchor.view.webContents.isDestroyed()
              ? context.anchor
              : await this.createPage(context.session);
          await this.expose(page);
          return { targetId: page.info.targetId };
        }
        case "Target.attachToTarget": {
          if (params.targetId === this.browserInfo.targetId) {
            const id = randomUUID();
            this.browserSessions.add(id);
            this.emit({
              method: "Target.attachedToTarget",
              params: { sessionId: id, targetInfo: this.browserInfo, waitingForDebugger: false },
            });
            return { sessionId: id };
          }
          const page = this.pages.get(params.targetId as string);
          if (!page?.exposed) throw new Error("Unknown native browser target.");
          return page.view.webContents.debugger.sendCommand(method, params);
        }
        case "Target.detachFromTarget": {
          const id = params.sessionId as string;
          if (this.browserSessions.delete(id)) {
            this.emit({ method: "Target.detachedFromTarget", params: { sessionId: id } });
            return {};
          }
          const session = this.sessions.get(id);
          if (!session) throw new Error("Unknown native browser session.");
          return session.page.view.webContents.debugger.sendCommand(method, params);
        }
        case "Target.closeTarget": {
          const page = this.pages.get(params.targetId as string);
          if (!page?.exposed) throw new Error("Unknown native browser target.");
          page.view.webContents.close();
          return { success: true };
        }
        case "Browser.close":
          this.close();
          return {};
      }
      if (method.startsWith("Target.") || method.startsWith("Browser."))
        throw new Error(`Unsupported native browser command: ${method}`);
      const context = this.contexts.get(params.browserContextId as string);
      if (!context) throw new Error(`Unsupported native browser command: ${method}`);
      const anchor = [...this.pages.values()].find(
        (page) => page.info.browserContextId === params.browserContextId,
      );
      if (!anchor) throw new Error("The native browser context closed.");
      return anchor.view.webContents.debugger.sendCommand(method, params);
    }
    const attached = this.sessions.get(sessionId!);
    if (!attached) throw new Error("Unknown native browser session.");
    const { page } = attached;
    if (method.startsWith("Target.")) {
      const infos = new Map([[page.info.targetId, page.info]]);
      for (const target of this.sessions.values())
        if (target.page === page) infos.set(target.info.targetId, target.info);
      switch (method) {
        case "Target.getTargets":
          return { targetInfos: [...infos.values()] };
        case "Target.getTargetInfo": {
          const info = infos.get((params.targetId as string | undefined) ?? attached.info.targetId);
          if (!info) throw new Error("Unknown native browser target.");
          break;
        }
        case "Target.attachToTarget":
          if (!infos.has(params.targetId as string))
            throw new Error("Unknown native browser target.");
          break;
        case "Target.detachFromTarget":
          if (this.sessions.get(params.sessionId as string)?.page !== page)
            throw new Error("Unknown native browser session.");
          break;
        case "Target.setAutoAttach":
          // Electron's debugger cannot resume auto-paused cross-site child renderers.
          // Attach without pausing so embedded pages keep loading and remain automatable.
          params = { ...params, waitForDebuggerOnStart: false };
          break;
        default:
          throw new Error(`Unsupported native browser command: ${method}`);
      }
    }
    if (method.startsWith("Browser."))
      throw new Error(`Unsupported native browser command: ${method}`);
    if (method === "Page.bringToFront") return {};
    return page.view.webContents.debugger.sendCommand(method, params, sessionId);
  }

  createPresenter(
    window: BrowserWindow,
    resized = () => {},
    shortcut: (action: Shortcut) => void = () => {},
    poster: (event: Extract<BrowserOutput, { kind: "frame" }>) => void = () => {},
  ) {
    let current: NativePage | undefined;
    let state: BrowserState | undefined;
    let visible = false;
    let bounds: BrowserNativeBounds | null = null;
    let closed = false;
    let shield: WebContentsView | undefined;
    let shieldAttached = false;
    let rectangle: Electron.Rectangle | undefined;
    let geometryDirty = true;
    const unshield = () => {
      if (!shieldAttached) return;
      if (!window.isDestroyed()) window.contentView.removeChildView(shield!);
      shield!.setVisible(false);
      shieldAttached = false;
    };
    const attachment = {
      park: () => {
        unshield();
        if (current?.presenter !== attachment) return;
        current.presenter = undefined;
        this.hide(current);
        if (
          !current.view.webContents.isDestroyed() &&
          this.parking &&
          !this.parking.isDestroyed()
        ) {
          this.parking.contentView.addChildView(current.view);
          current.owner = this.parking;
          current.view.setVisible(true);
        }
        geometryDirty = true;
      },
    };
    const render = () => {
      if (closed || window.isDestroyed()) return;
      if (
        !visible ||
        !bounds ||
        bounds.occluded ||
        !current ||
        current.view.webContents.isDestroyed() ||
        !state ||
        state.dialog ||
        state.fileChooser ||
        current.info.url === "about:blank"
      ) {
        attachment.park();
        return;
      }
      if (current.presenter && current.presenter !== attachment) {
        if (state.control !== "you") return;
        current.presenter.park();
      }
      const other = this.presenters.get(window.id);
      if (other !== attachment.park) {
        other?.();
        this.presenters.set(window.id, attachment.park);
      }
      if (current.presenter !== attachment) {
        this.hide(current);
        window.contentView.addChildView(current.view);
        current.owner = window;
        current.view.setVisible(true);
        current.presenter = attachment;
        current.shortcut = shortcut;
        geometryDirty = true;
        rectangle = undefined;
      }
      if (geometryDirty) {
        const zoom = window.webContents.getZoomFactor();
        const [width, height] = window.getContentSize();
        const x = Math.max(0, Math.min(width, Math.round(bounds.x * zoom)));
        const y = Math.max(0, Math.min(height, Math.round(bounds.y * zoom)));
        const next = {
          x,
          y,
          width: Math.min(width - x, Math.round(bounds.width * zoom)),
          height: Math.min(height - y, Math.round(bounds.height * zoom)),
        };
        if (next.width < 1 || next.height < 1) {
          attachment.park();
          return;
        }
        const resizedView =
          !rectangle || next.width !== rectangle.width || next.height !== rectangle.height;
        if (resizedView || next.x !== rectangle?.x || next.y !== rectangle?.y)
          current.view.setBounds(next);
        rectangle = next;
        const viewport = bounds.viewport;
        const key = viewport ? `${viewport.width}:${viewport.height}:${bounds.zoom}:${zoom}` : "";
        const emulatedChanged = key !== current.emulationKey;
        if (emulatedChanged) {
          if (viewport)
            current.view.webContents.enableDeviceEmulation({
              screenPosition: "desktop",
              screenSize: viewport,
              viewPosition: { x: 0, y: 0 },
              deviceScaleFactor: 0,
              viewSize: viewport,
              scale: (bounds.zoom ?? 1) * zoom,
            });
          else current.view.webContents.disableDeviceEmulation();
          current.emulationKey = key;
        }
        if (resizedView || emulatedChanged) setImmediate(resized);
        if (shieldAttached) shield!.setBounds(next);
        geometryDirty = false;
      }
      const interactive = state.control === "you";
      current.input = interactive;
      if (interactive) unshield();
      else if (!shieldAttached) {
        if (!shield) {
          shield = new WebContentsView({
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
          });
          shield.setBackgroundColor("#00000000");
        }
        window.contentView.addChildView(shield);
        shield.setBounds(rectangle!);
        shield.setVisible(true);
        shieldAttached = true;
        if (current.view.webContents.isFocused()) shield.webContents.focus();
      }
    };
    const refresh = () => {
      geometryDirty = true;
      render();
    };
    const close = () => {
      if (closed) return;
      closed = true;
      attachment.park();
      if (this.presenters.get(window.id) === attachment.park) this.presenters.delete(window.id);
      if (shield && !shield.webContents.isDestroyed()) shield.webContents.close();
      window.removeListener("closed", close);
      window.removeListener("resize", refresh);
    };
    window.once("closed", close);
    window.on("resize", refresh);
    return {
      update: (next: BrowserState, shown: boolean) => {
        if (closed) return false;
        const native = this.pages.get(
          next.tabs.find((tab) => tab.id === next.activeTabId)?.nativeTargetId ?? "",
        );
        if (current !== native) {
          attachment.park();
          current = native;
          rectangle = undefined;
          geometryDirty = true;
        }
        state = next;
        visible = shown;
        render();
        return (
          (!next.activeTabId || Boolean(native)) &&
          (!native?.presenter || native.presenter === attachment || next.control === "you")
        );
      },
      layout: (next: BrowserNativeBounds | null) => {
        if (closed) return;
        if (next?.occluded && !bounds?.occluded && current?.presenter === attachment && state) {
          const tab = state.tabs.find((tab) => tab.id === state!.activeTabId);
          if (tab)
            void current.view.webContents
              .capturePage()
              .then((image) => {
                if (closed || !bounds?.occluded || state?.activeTabId !== tab.id) return;
                const data = image.toPNG();
                if (data.byteLength <= 8 * 1024 * 1024)
                  poster({
                    kind: "frame",
                    tabId: tab.id,
                    viewId: tab.viewId,
                    frameId: randomInt(1, 2 ** 48),
                    data,
                  });
              })
              .catch(() => {});
        }
        bounds = next;
        geometryDirty = true;
        if (!bounds || bounds.occluded) attachment.park();
        else render();
      },
      close,
    };
  }

  private hide(page: NativePage) {
    page.presenter = undefined;
    page.input = false;
    page.shortcut = undefined;
    page.view.setVisible(false);
    if (page.owner && !page.owner.isDestroyed()) page.owner.contentView.removeChildView(page.view);
    page.owner = undefined;
  }

  async reset() {
    await this.close();
    this.closed = false;
    this.pending = undefined;
    this.browserSessions.clear();
    this.attaching = false;
    this.discovering = false;
    this.parking = undefined;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const view of this.opening) if (!view.webContents.isDestroyed()) view.webContents.close();
    for (const page of this.pages.values()) {
      this.hide(page);
      page.view.webContents.close();
    }
    this.parking?.destroy();
    this.sessions.clear();
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    this.onclose?.();
    await Promise.all(
      contexts.map(async (context) => {
        context.session.removeAllListeners("will-download");
        for (const item of context.downloads.values()) item.cancel();
        await Promise.all([context.session.clearStorageData(), context.session.clearCache()]);
      }),
    );
  }
}
