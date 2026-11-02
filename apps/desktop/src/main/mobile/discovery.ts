import { access, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, relative, resolve, sep } from "node:path";
import type { MobileDevice, MobileState, MobileTarget } from "../../shared/contracts/mobile";
import { mobileExec } from "./process";
import { readLocalFile } from "../platform/local-files";

export async function executable(name: string, extra: string[] = []) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const candidate of [
    ...extra,
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((path) => join(path, name + suffix)),
  ]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Continue discovery. */
    }
  }
  return undefined;
}
export async function androidTools() {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
    join(homedir(), "Android/Sdk"),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Android/Sdk")] : []),
  ].filter((path): path is string => Boolean(path));
  const [adb, emulator] = await Promise.all([
    executable(
      "adb",
      roots.map((root) =>
        join(root, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"),
      ),
    ),
    executable(
      "emulator",
      roots.map((root) =>
        join(root, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator"),
      ),
    ),
  ]);
  return { adb, emulator, roots };
}

export function iosDevices(value: unknown): MobileDevice[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("devices" in value) ||
    !value.devices ||
    typeof value.devices !== "object"
  )
    return [];
  return Object.entries(value.devices)
    .flatMap(([runtime, entries]) =>
      !Array.isArray(entries)
        ? []
        : entries.flatMap((entry) => {
            if (
              !entry ||
              !entry.isAvailable ||
              typeof entry.udid !== "string" ||
              !/^[A-F0-9-]{36}$/i.test(entry.udid) ||
              typeof entry.name !== "string"
            )
              return [];
            // Apple TV, Watch and visionOS use different input models.
            if (!/\.iOS-/.test(runtime)) return [];
            return [
              {
                id: entry.udid,
                platform: "ios" as const,
                name: entry.name,
                runtime: runtime.replace(/^.*\.iOS-/, "iOS ").replaceAll("-", "."),
                state:
                  entry.state === "Booted"
                    ? ("running" as const)
                    : entry.state === "Booting"
                      ? ("starting" as const)
                      : ("stopped" as const),
              },
            ];
          }),
    )
    .slice(0, 200);
}

export async function discoverDevices(): Promise<Pick<MobileState, "devices" | "requirements">> {
  const devices: MobileDevice[] = [];
  const requirements: MobileState["requirements"] = [];
  await Promise.all([
    (async () => {
      if (process.platform !== "darwin") {
        requirements.push({
          platform: "ios",
          ready: false,
          message: "Connect to a Mac with Xcode to use iOS simulators.",
          helpURL: "https://developer.apple.com/xcode/",
        });
        return;
      }
      try {
        const output = await mobileExec("/usr/bin/xcrun", [
          "simctl",
          "list",
          "devices",
          "available",
          "--json",
        ]);
        const found = iosDevices(JSON.parse(output));
        devices.push(...found);
        const supported = process.arch === "arm64" || Boolean(process.env.TIDY_IDB_COMPANION);
        requirements.push({
          platform: "ios",
          ready: supported && found.length > 0,
          message: !supported
            ? "Interactive iOS previews require an Apple silicon Mac."
            : found.length
              ? "Xcode is ready"
              : "Add an iOS runtime in Xcode → Settings → Components.",
          helpURL:
            "https://developer.apple.com/documentation/xcode/installing-additional-simulator-runtimes",
        });
      } catch {
        requirements.push({
          platform: "ios",
          ready: false,
          message: "Install Xcode, open it once, and add an iOS simulator runtime.",
          helpURL: "https://developer.apple.com/xcode/",
        });
      }
    })(),
    (async () => {
      const tools = await androidTools();
      if (!tools.adb || !tools.emulator) {
        requirements.push({
          platform: "android",
          ready: false,
          message:
            "Install Android Studio, its SDK Platform-Tools and Android Emulator, then create a virtual device.",
          helpURL: "https://developer.android.com/studio/run/managing-avds",
        });
        return;
      }
      try {
        const [avds, running] = await Promise.all([
          mobileExec(tools.emulator, ["-list-avds"]),
          mobileExec(tools.adb, ["devices"]),
        ]);
        const active = new Map<string, { serial: string; state: "running" | "offline" }>();
        await Promise.all(
          running.split(/\r?\n/).flatMap((line) => {
            const match = /^(emulator-\d+)\s+(device|offline)$/.exec(line.trim());
            if (!match) return [];
            return [
              (async () => {
                if (match[2] === "offline") return;
                const name = (
                  await mobileExec(tools.adb!, ["-s", match[1], "emu", "avd", "name"]).catch(
                    () => "",
                  )
                )
                  .split(/\r?\n/)[0]
                  .trim();
                if (name) active.set(name, { serial: match[1], state: "running" });
              })(),
            ];
          }),
        );
        for (const name of avds
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^[a-zA-Z0-9_.-]{1,150}$/.test(line))) {
          devices.push({
            id: `avd:${name}`,
            platform: "android",
            name: name.replaceAll("_", " "),
            runtime: "Android",
            state: active.get(name)?.state ?? "stopped",
          });
        }
        requirements.push({
          platform: "android",
          ready: Boolean(avds.trim()),
          message: avds.trim()
            ? "Android SDK is ready"
            : "Create a virtual device in Android Studio → Device Manager.",
          helpURL: "https://developer.android.com/studio/run/managing-avds",
        });
      } catch {
        requirements.push({
          platform: "android",
          ready: false,
          message: "Android tools could not start. Check your SDK installation in Android Studio.",
          helpURL: "https://developer.android.com/studio/intro/update#sdk-manager",
        });
      }
    })(),
  ]);
  devices.sort(
    (a, b) =>
      Number(b.state === "running") - Number(a.state === "running") ||
      a.platform.localeCompare(b.platform) ||
      a.name.localeCompare(b.name),
  );
  requirements.sort((a, b) => a.platform.localeCompare(b.platform));
  return { devices: devices.slice(0, 200), requirements };
}

const excluded = new Set([
  "node_modules",
  ".git",
  ".tidy",
  "Pods",
  "build",
  "dist",
  ".next",
  ".gradle",
  ".dart_tool",
  "DerivedData",
  "vendor",
]);

/** Bounded discovery supports monorepos without traversing dependencies or following symlinks. */
export async function discoverTargets(root: string): Promise<MobileTarget[]> {
  const targets: MobileTarget[] = [];
  let scanned = 0;
  async function visit(directory: string, depth: number) {
    if (++scanned > 150 || targets.length >= 100) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const names = new Set(entries.map((entry) => entry.name));
    const path = relative(root, directory).split(sep).join("/") || ".";
    const add = (
      kind: MobileTarget["kind"],
      name: string,
      platforms: MobileTarget["platforms"],
      scheme?: string,
      id = `${kind}:${path}`,
    ) => {
      targets.push({ id, kind, name, directory: path, platforms, ...(scheme ? { scheme } : {}) });
    };
    if (
      names.has("pubspec.yaml") &&
      /sdk:\s*flutter/.test(
        await readLocalFile(join(directory, "pubspec.yaml"), 1_000_000)
          .then((value) => value.toString("utf8"))
          .catch(() => ""),
      )
    ) {
      add("flutter", basename(directory), ["ios", "android"]);
      return;
    }
    if (names.has("package.json")) {
      try {
        const pkg = JSON.parse(
          (await readLocalFile(join(directory, "package.json"), 1_000_000)).toString("utf8"),
        );
        const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
        if (dependencies.expo || dependencies["react-native"]) {
          add(
            dependencies.expo ? "expo" : "react-native",
            typeof pkg.name === "string" ? pkg.name : basename(directory),
            ["ios", "android"],
          );
          return;
        }
      } catch {
        /* A broken manifest must not hide other apps. */
      }
    }
    const workspaces = entries.filter(
      (entry) => entry.isDirectory() && entry.name.endsWith(".xcworkspace"),
    );
    const projects = entries.filter(
      (entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"),
    );
    for (const entry of workspaces.length ? workspaces : projects) {
      const bundle = join(directory, entry.name);
      const schemes = await readdir(join(bundle, "xcshareddata", "xcschemes")).catch(() => []);
      if (schemes.length) {
        for (const scheme of schemes.filter((name) => name.endsWith(".xcscheme"))) {
          const name = scheme.slice(0, -9);
          add("xcode", name, ["ios"], name, `xcode:${path}/${entry.name}:${name}`);
        }
      } else
        add(
          "xcode",
          entry.name.replace(/\.(?:xcworkspace|xcodeproj)$/, ""),
          ["ios"],
          undefined,
          `xcode:${path}/${entry.name}`,
        );
    }
    if (names.has("gradlew") || names.has("gradlew.bat")) {
      add(
        "gradle",
        basename(directory) === "android"
          ? basename(resolve(directory, ".."))
          : basename(directory),
        ["android"],
      );
      return;
    }
    if (depth >= 4) return;
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        excluded.has(entry.name) ||
        entry.name.startsWith(".") ||
        /\.(?:xcworkspace|xcodeproj)$/.test(entry.name)
      )
        continue;
      await visit(join(directory, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  return targets.slice(0, 100);
}

export async function targetDirectory(root: string, target: MobileTarget) {
  const directory = await realpath(resolve(root, target.directory));
  const base = await realpath(root);
  const path = relative(base, directory);
  if (path === ".." || path.startsWith(`..${sep}`) || path.startsWith(sep))
    throw new Error("The app must be inside this project.");
  return directory;
}
