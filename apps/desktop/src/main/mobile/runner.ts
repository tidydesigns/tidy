import WebSocket from "ws";
import { createRequire } from "node:module";
import { readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { MobileDevice, MobileTarget } from "../../shared/contracts/mobile";
import { androidTools, executable, targetDirectory } from "./discovery";
import { mobileCache } from "./runtime";
import { mobileExec, mobileProcess, type MobileProcess } from "./process";
import { unusedPort } from "./bridges";
import { createHash } from "node:crypto";

export type RunningApp = { stop(): void | Promise<void>; reload(): Promise<void> };
export type RunOptions = {
  root: string;
  target: MobileTarget;
  device: MobileDevice;
  serial: string;
  signal: AbortSignal;
  output(text: string): void;
  stage(message: string): void;
  running(): void;
  failed(error: unknown): void;
};

export async function runMobileApp(options: RunOptions): Promise<RunningApp> {
  const { root, target, device, serial, signal, output, stage, running, failed } = options;
  const cwd = await targetDirectory(root, target);
  const children = new Set<MobileProcess>();
  let stopped = false;
  let reload: (() => Promise<void>) | undefined;
  let terminate: (() => Promise<unknown>) | undefined;
  const start = (bin: string, args: string[], env?: NodeJS.ProcessEnv) => {
    signal.throwIfAborted();
    const child = mobileProcess(bin, args, {
      cwd,
      env,
      signal,
      timeout: 24 * 60 * 60 * 1000,
      output,
    });
    children.add(child);
    void child.done.finally(() => children.delete(child)).catch(() => {});
    return child;
  };
  const watch = (child: MobileProcess, message: string) => {
    void child.done.then(
      () => {
        if (!signal.aborted && !stopped) failed(new Error(message));
      },
      (error: unknown) => {
        if (!signal.aborted && !stopped) failed(error);
      },
    );
  };
  const run = async (bin: string, args: string[], env?: NodeJS.ProcessEnv) => {
    await start(bin, args, env).done;
  };
  const launchIOS = async (app: string) => {
    stage("Installing app…");
    await run("/usr/bin/xcrun", ["simctl", "install", serial, app]);
    const bundleId = (
      await mobileExec(
        "/usr/bin/plutil",
        ["-extract", "CFBundleIdentifier", "raw", join(app, "Info.plist")],
        { signal },
      )
    ).trim();
    if (!/^[a-zA-Z0-9.-]+$/.test(bundleId))
      throw new Error("The built app has an invalid bundle identifier.");
    stage("Opening app…");
    terminate = () =>
      mobileExec("/usr/bin/xcrun", ["simctl", "terminate", serial, bundleId], { timeout: 5000 });
    await run("/usr/bin/xcrun", [
      "simctl",
      "launch",
      "--terminate-running-process",
      serial,
      bundleId,
    ]);
    reload = () =>
      run("/usr/bin/xcrun", ["simctl", "launch", "--terminate-running-process", serial, bundleId]);
  };
  try {
    if (target.kind === "flutter") {
      const flutter = await executable("flutter");
      if (!flutter)
        throw new Error(
          "Install Flutter on this machine and restart Tidy so it can find the Flutter SDK.",
        );
      const child = start(flutter, ["run", "--device-id", serial]);
      reload = async () => {
        if (
          child.process.exitCode !== null ||
          child.process.signalCode !== null ||
          !child.process.stdin.writable ||
          child.process.stdin.destroyed
        )
          throw new Error("Flutter stopped. Run the app again.");
        await new Promise<void>((resolve, reject) => {
          child.process.stdin.write("r", (error) => (error ? reject(error) : resolve()));
        });
      };
      // Flutter remains attached to the app, supplying hot reload and logs.
      watch(child, "Flutter stopped. Run the app again.");
      let ready = false;
      child.process.stdout.on("data", (chunk: Buffer) => {
        if (
          !ready &&
          /Flutter run key commands|A Dart VM Service|Syncing files to device/.test(
            chunk.toString(),
          )
        ) {
          ready = true;
          running();
        }
      });
    } else if (target.kind === "expo" || target.kind === "react-native") {
      const require = createRequire(join(cwd, "package.json"));
      let cli: string;
      try {
        cli =
          target.kind === "expo"
            ? join(dirname(require.resolve("expo/package.json")), "bin", "cli")
            : require.resolve("react-native/cli.js");
      } catch {
        throw new Error(
          "This app's dependencies are missing. Install the project dependencies in Tidy's terminal, then run again.",
        );
      }
      const node = await executable("node");
      if (!node) throw new Error("Install Node.js on this machine to run this app.");
      const port = await unusedPort();
      stage("Starting development server…");
      const bundler = start(
        node,
        [cli, "start", "--port", String(port), ...(target.kind === "expo" ? ["--localhost"] : [])],
        // Metro must watch files for Fast Refresh. Piped stdio already prevents CLI prompts.
        { CI: "false", BROWSER: "none" },
      );
      watch(bundler, "The development server stopped. Run the app again.");
      for (let retry = 0; retry < 120; retry++) {
        signal.throwIfAborted();
        if (bundler.process.exitCode !== null) {
          await bundler.done;
          throw new Error("The development server stopped.");
        }
        try {
          const status = await fetch(`http://127.0.0.1:${port}/status`, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
          });
          if (status.ok && (await status.text()).includes("packager-status:running")) break;
        } catch {
          /* Metro is still starting. */
        }
        if (retry === 119)
          throw new Error(
            "The development server did not start. Check the build output and retry.",
          );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      stage("Building app…");
      if (device.platform === "android") {
        const { adb } = await androidTools();
        if (adb) await run(adb, ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`]);
      }
      const args =
        target.kind === "expo"
          ? [cli, `run:${device.platform}`, "--device", serial, "--no-bundler"]
          : [
              cli,
              device.platform === "ios" ? "run-ios" : "run-android",
              device.platform === "ios" ? "--udid" : "--device",
              serial,
              "--no-packager",
              "--port",
              String(port),
            ];
      // Expo disallows --port with --no-bundler. Its launch URL override points
      // the native app at our existing loopback-only Metro, without a second server.
      await run(node, args, {
        CI: "1",
        BROWSER: "none",
        ANDROID_SERIAL: serial,
        ...(target.kind === "expo"
          ? { EXPO_PACKAGER_PROXY_URL: `http://127.0.0.1:${port}`, RCT_METRO_PORT: String(port) }
          : {}),
      });
      reload = () => reloadMetro(port, signal);
      running();
    } else if (target.kind === "xcode") {
      const entries = await readdir(cwd, { withFileTypes: true });
      const candidates = entries.filter(
        (entry) => entry.isDirectory() && /\.(?:xcworkspace|xcodeproj)$/.test(entry.name),
      );
      // The target ID is generated by discovery and looked up again before executing.
      const bundle = candidates.find((entry) =>
        target.id.startsWith(`xcode:${target.directory}/${entry.name}`),
      );
      if (!bundle)
        throw new Error("The Xcode project moved. Refresh Devices and choose its new target.");
      const projectArgs = [
        bundle.name.endsWith(".xcworkspace") ? "-workspace" : "-project",
        bundle.name,
      ];
      let scheme = target.scheme;
      if (!scheme) {
        stage("Reading Xcode schemes…");
        const result = JSON.parse(
          await mobileExec("/usr/bin/xcrun", ["xcodebuild", ...projectArgs, "-list", "-json"], {
            cwd,
            signal,
            timeout: 90_000,
          }),
        );
        const schemes = result.workspace?.schemes ?? result.project?.schemes;
        scheme = Array.isArray(schemes)
          ? (schemes.find((value: unknown) => typeof value === "string" && value === target.name) ??
            schemes[0])
          : undefined;
      }
      if (!scheme || typeof scheme !== "string" || scheme.startsWith("-"))
        throw new Error(
          "Share an app scheme in Xcode → Product → Scheme → Manage Schemes, then refresh Devices.",
        );
      const key = createHash("sha256").update(cwd).update(scheme).digest("hex").slice(0, 24);
      const derived = join(await mobileCache(), "builds", key);
      stage(`Building ${scheme}…`);
      await run("/usr/bin/xcrun", [
        "xcodebuild",
        ...projectArgs,
        "-scheme",
        scheme,
        "-configuration",
        "Debug",
        "-destination",
        `platform=iOS Simulator,id=${serial}`,
        "-derivedDataPath",
        derived,
        "CODE_SIGNING_ALLOWED=NO",
        "build",
      ]);
      const products = join(derived, "Build/Products/Debug-iphonesimulator");
      const apps = (await readdir(products)).filter((name) => name.endsWith(".app"));
      const name =
        apps.find((name) => name === `${scheme}.app`) ?? (apps.length === 1 ? apps[0] : undefined);
      if (!name)
        throw new Error(
          "This scheme did not produce a single iOS app. Choose its app scheme and run again.",
        );
      await launchIOS(join(products, name));
      running();
    } else {
      const { adb, roots } = await androidTools();
      if (!adb) throw new Error("Android Platform-Tools are unavailable.");
      stage("Building Android app…");
      if (process.platform === "win32")
        throw new Error(
          "Gradle builds currently require a macOS or Linux host. Device previews are still available on Windows.",
        );
      await run("/bin/sh", ["./gradlew", ":app:assembleDebug", "--console=plain"], {
        ANDROID_SERIAL: serial,
      });
      const products = join(cwd, "app/build/outputs/apk/debug");
      const apks = (await readdir(products)).filter((name) => name.endsWith(".apk"));
      if (apks.length !== 1)
        throw new Error(
          "Choose an Android app with a single debug APK. Product flavors can be run from Tidy's terminal while using this preview.",
        );
      const apk = await realpath(join(products, apks[0]));
      if (relative(cwd, apk).startsWith(`..${sep}`))
        throw new Error("The built APK must be inside the app directory.");
      let aapt: string | undefined;
      for (const root of roots) {
        const versions = (await readdir(join(root, "build-tools")).catch(() => []))
          .sort()
          .reverse();
        aapt = await executable(
          "aapt",
          versions.map((version) => join(root, "build-tools", version, "aapt")),
        );
        if (aapt) break;
      }
      if (!aapt)
        throw new Error("Install Android SDK Build-Tools in Android Studio to open the built app.");
      const metadata = await mobileExec(aapt, ["dump", "badging", apk], { signal });
      const packageId = /^package: name='([a-zA-Z0-9_.]+)'/m.exec(metadata)?.[1];
      const activity = /^launchable-activity: name='([a-zA-Z0-9_.$]+)'/m.exec(metadata)?.[1];
      if (!packageId || !activity) throw new Error("The debug APK has no launchable activity.");
      stage("Installing app…");
      await run(adb, ["-s", serial, "install", "-r", "-t", apk]);
      const launch = () =>
        run(adb, ["-s", serial, "shell", "am", "start", "-S", "-n", `${packageId}/${activity}`]);
      await launch();
      terminate = () =>
        mobileExec(adb, ["-s", serial, "shell", "am", "force-stop", packageId], { timeout: 5000 });
      reload = launch;
      running();
    }
    signal.throwIfAborted();
    return {
      async stop() {
        if (stopped) return;
        stopped = true;
        for (const child of children) child.stop();
        await terminate?.().catch(() => {});
      },
      async reload() {
        if (stopped) throw new Error("Run this app again before reloading it.");
        if (reload) await reload();
      },
    };
  } catch (error) {
    for (const child of children) child.stop();
    await terminate?.().catch(() => {});
    throw error;
  }
}

/** Metro 0.88 / Expo 58 use the version 2 command socket; /reload can return an HTML page. */
export function reloadMetro(port: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/message`, {
      handshakeTimeout: 5000,
      maxPayload: 64 * 1024,
    });
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("App run stopped."));
    const timer = setTimeout(
      () => finish(new Error("Metro did not acknowledge the reload. Run the app again.")),
      5000,
    );
    signal.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => finish(error));
    socket.once("close", () =>
      finish(new Error("The development server disconnected before reloading.")),
    );
    socket.once("open", () =>
      socket.send(JSON.stringify({ version: 2, method: "reload" }), (error) => {
        if (error) finish(error);
      }),
    );
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.version === 2 && message.method === "reload") finish();
      } catch {
        /* Ignore unrelated Metro messages. */
      }
    });
  });
}
