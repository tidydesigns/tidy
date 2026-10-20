import { packager } from "@electron/packager";
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../package.json";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const repository = fileURLToPath(new URL("../../..", import.meta.url));
/** Package the native app with numeric macOS versions and security fuses, ready for signing. */
export async function packageDesktop() {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "tidy-desktop-"));

  try {
    await cp(join(appDirectory, "out"), join(stagingDirectory, "out"), { recursive: true });
    await cp(join(repository, "LICENSE"), join(stagingDirectory, "LICENSE"));
    await cp(
      join(repository, "THIRD_PARTY_NOTICES.md"),
      join(stagingDirectory, "THIRD_PARTY_NOTICES.md"),
    );
    await cp(join(repository, "licenses/bundled"), join(stagingDirectory, "licenses/bundled"), {
      recursive: true,
    });
    await cp(
      join(repository, "packages/editor/src/assets/icons/LICENSE.iconoir"),
      join(stagingDirectory, "licenses/LICENSE.iconoir"),
    );
    await cp(
      join(repository, "packages/ui/harness-icons/README.md"),
      join(stagingDirectory, "licenses/harness-marks.txt"),
    );
    for (const name of ["OFL-InstrumentSans.txt", "OFL-InstrumentSerif.txt"]) {
      await cp(
        join(repository, "packages/ui/fonts", name),
        join(stagingDirectory, "licenses", name),
      );
    }
    await writeFile(
      join(stagingDirectory, "package.json"),
      JSON.stringify({
        name: "tidy-desktop",
        productName: "Tidy",
        version: manifest.version,
        type: manifest.type,
        main: manifest.main,
        license: manifest.license,
      }),
    );

    const paths = await packager({
      dir: stagingDirectory,
      name: "Tidy",
      appBundleId: "co.tidydesign.desktop",
      appCategoryType: "public.app-category.graphics-design",
      buildVersion: manifest.desktopBuildNumber,
      electronVersion: manifest.devDependencies.electron,
      out: join(appDirectory, "release"),
      asar: true,
      overwrite: true,
      prune: false,
    });
    for (const path of paths) {
      const executable =
        process.platform === "darwin"
          ? join(path, "Tidy.app")
          : join(path, process.platform === "win32" ? "Tidy.exe" : "Tidy");
      if (process.platform === "darwin") {
        // Keep the full SemVer in app.asar while giving macOS numeric bundle versions.
        const frameworks = join(executable, "Contents/Frameworks");
        const helpers = (await readdir(frameworks))
          .filter((name) => name.endsWith(".app"))
          .map((name) => join(frameworks, name));
        for (const bundle of [executable, ...helpers]) {
          execFileSync("/usr/libexec/PlistBuddy", [
            "-c",
            `Set :CFBundleShortVersionString ${manifest.version.split("-")[0]}`,
            join(bundle, "Contents/Info.plist"),
          ]);
        }
      }
      await flipFuses(executable, {
        version: FuseVersion.V1,
        resetAdHocDarwinSignature: process.platform === "darwin",
        strictlyRequireAllFuses: true,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: process.platform !== "linux",
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: true,
      });
      console.info(`Packaged Tidy: ${path}`);
    }
    return paths;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) await packageDesktop();
