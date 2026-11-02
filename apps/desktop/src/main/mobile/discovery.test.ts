import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTargets, iosDevices, targetDirectory } from "./discovery";

const directories: string[] = [];
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-mobile-discovery-"));
  directories.push(root);
  return root;
}
async function file(root: string, path: string, text: string) {
  const value = join(root, path);
  await mkdir(join(value, ".."), { recursive: true });
  await writeFile(value, text);
}

test("finds mobile apps inside a monorepo while ignoring dependency trees and symlinks", async () => {
  const root = await fixture();
  await file(root, "package.json", '{"name":"workspace"}');
  await file(
    root,
    "apps/native/package.json",
    '{"name":"my-app","dependencies":{"expo":"1","react-native":"1"}}',
  );
  await file(root, "apps/native/ios/MyApp.xcodeproj/project.pbxproj", "");
  await file(
    root,
    "apps/flutter/pubspec.yaml",
    "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
  );
  await file(root, "node_modules/other/package.json", '{"dependencies":{"react-native":"1"}}');
  await symlink(join(root, "apps/native"), join(root, "linked"));
  const targets = await discoverTargets(root);
  expect(targets.map((target) => target.kind).sort()).toEqual(["expo", "flutter"]);
  expect(targets.find((target) => target.kind === "expo")?.directory).toBe("apps/native");
});

test("discovers Xcode app schemes and keeps project names intact", async () => {
  const root = await fixture();
  await file(root, "ios/My App.xcodeproj/xcshareddata/xcschemes/My App.xcscheme", "");
  const targets = await discoverTargets(root);
  expect(targets).toEqual([
    {
      id: "xcode:ios/My App.xcodeproj:My App",
      name: "My App",
      directory: "ios",
      kind: "xcode",
      platforms: ["ios"],
      scheme: "My App",
    },
  ]);
});

test("a workspace takes precedence over its contained Xcode project", async () => {
  const root = await fixture();
  await file(root, "App.xcworkspace/contents.xcworkspacedata", "");
  await file(root, "App.xcodeproj/project.pbxproj", "");
  const targets = await discoverTargets(root);
  expect(targets).toHaveLength(1);
  expect(targets[0].id).toBe("xcode:./App.xcworkspace");
  expect(targets[0].name).toBe("App");
});

test("a target cannot escape the project through a symlink", async () => {
  const root = await fixture(),
    external = await fixture();
  await symlink(external, join(root, "app"));
  await expect(
    targetDirectory(root, {
      id: "expo:app",
      name: "app",
      kind: "expo",
      directory: "app",
      platforms: ["ios"],
    }),
  ).rejects.toThrow("inside this project");
});

test("device discovery excludes unavailable and non-iOS runtimes", () => {
  const entry = {
    udid: "D1820EE0-3A9F-40BB-82DE-CC29536B6CC1",
    name: "iPhone",
    isAvailable: true,
    state: "Booted",
  };
  expect(
    iosDevices({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [entry, { ...entry, isAvailable: false }],
        "com.apple.CoreSimulator.SimRuntime.tvOS-26-5": [entry],
      },
    }),
  ).toEqual([
    { id: entry.udid, name: "iPhone", state: "running", platform: "ios", runtime: "iOS 26.5" },
  ]);
});
