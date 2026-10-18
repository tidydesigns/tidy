import { packager } from "@electron/packager";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../package.json";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const repository = fileURLToPath(new URL("../../..", import.meta.url));
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
  for (const name of ["OFL-InstrumentSans.txt", "OFL-InstrumentSerif.txt"]) {
    await cp(join(repository, "packages/ui/fonts", name), join(stagingDirectory, "licenses", name));
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
    electronVersion: manifest.devDependencies.electron,
    out: join(appDirectory, "release"),
    asar: true,
    overwrite: true,
    prune: false,
  });
  for (const path of paths) console.info(`Packaged Tidy: ${path}`);
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
