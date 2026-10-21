import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { app, autoUpdater, net } from "electron";

// Run the actual built main process on the architecture supported by the publisher.
// Only installer/network effects are synthetic; no release, credentials or model inference.
if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.info("SKIP: update lifecycle requires an Apple Silicon Mac.");
  app.exit(0);
}
const temporary = await mkdtemp(join(tmpdir(), "tidy-update-lifecycle-"));
app.setPath("userData", temporary);
Object.defineProperty(app, "isPackaged", { get: () => true });
const bin = join(temporary, "bin");
await mkdir(bin);
for (const name of ["codex", "claude"]) {
  await copyFile(new URL("../src/main/fixtures/harness.mjs", import.meta.url), join(bin, name));
  await chmod(join(bin, name), 0o700);
}
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.ELECTRON_RENDERER_URL;
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = `${Number(manifest.version.split(".")[0]) + 1}.0.0`;
const tag = `desktop-v${version}`;
const feed = `https://github.com/tidydesigns/tidy/releases/download/${tag}/desktop-update-arm64.json`;
const originalFetch = net.fetch.bind(net);
/** Supply a newer release while allowing only local renderer resources through to Electron. */
net.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.github.com/repos/tidydesigns/tidy/releases?")) {
    return new Response(
      JSON.stringify([
        {
          tag_name: tag,
          draft: false,
          prerelease: false,
          assets: ["desktop-update-arm64.json", `Tidy-${version}-mac-arm64.zip`].map((name) => ({
            name,
            size: 100,
            browser_download_url: `https://github.com/tidydesigns/tidy/releases/download/${tag}/${name}`,
          })),
        },
      ]),
    );
  }
  assert.ok(String(url).startsWith("file:"), "fixture must not access the network");
  return originalFetch(url, init);
};
const initialListeners = autoUpdater.listenerCount("error");
let installs = 0;
let selectedFeed;
/** Capture the production controller's feed selection without contacting Squirrel. */
autoUpdater.setFeedURL = ({ url }) => {
  selectedFeed = url;
};
/** Stage the synthetic update through native events after validating the selected feed. */
autoUpdater.checkForUpdates = () => {
  assert.equal(selectedFeed, feed);
  queueMicrotask(() => autoUpdater.emit("update-downloaded"));
};
/** Reproduce Electron's quit event followed by an asynchronous native install failure. */
autoUpdater.quitAndInstall = () => {
  installs++;
  let prevented = false;
  app.emit("before-quit", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, false, "prepared update quit should proceed");
  assert.equal(
    autoUpdater.listenerCount("error"),
    initialListeners + 1,
    "update quit must preserve native failure recovery",
  );
  setImmediate(() => autoUpdater.emit("error", new Error("synthetic installer failure")));
};
let result = 1;
const deadline = setTimeout(() => {
  console.error("Update lifecycle smoke timed out.");
  app.exit(1);
}, 45_000);
app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    /** Inspect the actual isolated renderer rather than bypassing its preload bridge. */
    const evaluate = (expression) => window.webContents.executeJavaScript(expression);
    /** Invoke update operations through the preload's trusted IPC path. */
    const api = (method) => evaluate(`window.tidy.${method}()`);
    /** Wait for observable main-process and renderer state, never internal implementation fields. */
    const waitReady = async (failed) => {
      const until = Date.now() + 8_000;
      while (Date.now() < until) {
        const state = await api("updateState");
        const badge = await evaluate(
          `document.querySelector(${JSON.stringify(
            failed ? ".app-update-warning" : ".app-update-ready",
          )})!==null`,
        );
        if (
          state.status === "ready" &&
          state.version === version &&
          badge &&
          (!failed || state.error === "install")
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Update did not become ready in the main process and renderer.");
    };
    try {
      await waitReady(false);
      await api("installUpdate");
      await waitReady(true);
      assert.equal(installs, 1);
      // Reaching the native installer again proves workspace admission and quit recovery.
      await api("installUpdate");
      await waitReady(true);
      assert.equal(installs, 2);
      result = 0;
      console.info(
        "PASS: discovery, native staging, trusted IPC notifications, restart failure recovery and retry.",
      );
    } catch (error) {
      console.error(error);
    }
    app.quit();
  });
});
app.on("will-quit", (event) => {
  event.preventDefault();
  clearTimeout(deadline);
  try {
    assert.equal(
      autoUpdater.listenerCount("error"),
      initialListeners,
      "normal quit must stop updater listeners",
    );
    console.info("PASS: normal quit cleans up the updater.");
  } catch (error) {
    console.error(error);
    result = 1;
  }
  void rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    .catch((error) => {
      console.error(error);
      result = 1;
    })
    .finally(() => app.exit(result));
});
await import("../out/main/index.js");
