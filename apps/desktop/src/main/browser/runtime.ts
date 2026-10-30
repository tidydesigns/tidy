import { downloadBrowserArchive } from "./download-archive";
import { lockBrowserInstall, BrowserInstallBusyError } from "./install-lock";
import { mkdir, chmod, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import {
  Browser as BrowserKind,
  detectBrowserPlatform,
  install,
  computeExecutablePath,
  uninstall,
  getDownloadUrl,
  Cache,
} from "@puppeteer/browsers";
import { launch, type Browser } from "puppeteer-core";

export class BrowserRuntime {
  private pending?: Promise<Browser>;
  private closing = false;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly progress: (fraction: number | null) => void,
    private readonly disconnected: () => void,
  ) {}

  get() {
    if (this.closing) return Promise.reject(new Error("The browser is closing."));
    this.pending ??= this.start().catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }

  private async start() {
    let executablePath = process.env.TIDY_BROWSER_EXECUTABLE;
    if (!executablePath) {
      const platform = detectBrowserPlatform();
      if (!platform)
        throw new Error(
          "The managed browser is unavailable on this host. Set TIDY_BROWSER_EXECUTABLE to a compatible Chrome or Chromium executable.",
        );
      const cacheDir = join(homedir(), ".cache", "tidy", "browser");
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await chmod(cacheDir, 0o700);
      this.progress(0);
      let release: (() => void) | undefined;
      const deadline = Date.now() + 180000;
      while (!release) {
        if (this.closing) throw new Error("The browser is closing.");
        try {
          release = lockBrowserInstall(join(cacheDir, "install.lock"));
        } catch (error) {
          if (!(error instanceof BrowserInstallBusyError)) throw error;
          if (Date.now() > deadline)
            throw new Error("Another browser installation is still running. Retry shortly.");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      try {
        const options = {
          browser: BrowserKind.CHROMEHEADLESSSHELL,
          platform,
          cacheDir,
          buildId: "156.0.8078.47",
        };
        const path = computeExecutablePath(options);
        try {
          await access(path);
        } catch {
          await uninstall(options);
          const url = getDownloadUrl(options.browser, platform, options.buildId);
          const browserRoot = new Cache(cacheDir).browserRoot(options.browser);
          await mkdir(browserRoot, { recursive: true, mode: 0o700 });
          let lastPercent = -1;
          const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(180000)]);
          await downloadBrowserArchive({
            url,
            path: join(browserRoot, `${options.buildId}-${basename(url.pathname)}`),
            signal,
            progress: (downloaded, total) => {
              const fraction = total > 0 ? Math.min(1, downloaded / total) : 0;
              const percent = Math.floor(fraction * 100);
              if (percent !== lastPercent) {
                lastPercent = percent;
                this.progress(fraction);
              }
            },
          }).catch((error: unknown) => {
            if (signal.aborted && !this.closing)
              throw new Error("Browser installation timed out. Check your connection and retry.");
            throw error;
          });
        }
        this.lifetime.signal.throwIfAborted();
        const installed = await install(options);
        executablePath = installed.executablePath;
      } finally {
        release();
      }
    }
    if (this.closing) throw new Error("The browser is closing.");
    this.progress(null);
    try {
      const browser = await launch({
        executablePath,
        headless: true,
        pipe: true,
        timeout: 30000,
        args: process.env.TIDY_BROWSER_SANDBOX === "0" ? ["--no-sandbox"] : [],
        defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      });
      if (this.closing) {
        await browser.close();
        throw new Error("The browser is closing.");
      }
      browser.once("disconnected", () => {
        this.pending = undefined;
        this.disconnected();
      });
      return browser;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Chrome could not start.";
      if (/sandbox|namespace|apparmor/i.test(message))
        throw new Error(
          "Chrome's sandbox is blocked on this host. Allow unprivileged user namespaces or configure a supported Chrome executable. The sandbox is never disabled automatically.",
        );
      if (/shared libraries|not found|ENOENT/.test(message))
        throw new Error(
          "Chrome could not start on this host. Install its operating-system dependencies, or set TIDY_BROWSER_EXECUTABLE to an installed Chrome or Chromium executable.",
        );
      throw new Error(`Browser startup failed: ${message.slice(0, 500)}`);
    }
  }

  async close() {
    this.closing = true;
    this.lifetime.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pending?.then((browser) => browser.close()).catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
