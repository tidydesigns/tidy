import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { bundleLicenseBanner } from "../../../scripts/bundle-licenses";

async function fixture(
  packages: { name: string; license: string; unused?: boolean }[],
  check: (build: Bun.BuildOutput) => Promise<void>,
) {
  const directory = await mkdtemp(resolve(tmpdir(), "tidy-bundle-notices-"));
  try {
    const imports: string[] = [];
    for (const [index, pkg] of packages.entries()) {
      const root = resolve(directory, "node_modules", pkg.name);
      await mkdir(root, { recursive: true });
      await writeFile(
        resolve(root, "package.json"),
        JSON.stringify({ name: pkg.name, version: "1.0.0", main: "index.js", sideEffects: false }),
      );
      await writeFile(resolve(root, "LICENSE"), pkg.license);
      await writeFile(resolve(root, "LICENSE.txt"), pkg.license);
      await writeFile(resolve(root, "index.js"), `export const value = ${index};`);
      imports.push(
        `import { value as value${index} } from ${JSON.stringify(pkg.name)};` +
          (pkg.unused ? "" : `console.log(value${index});`),
      );
    }
    const entry = resolve(directory, "entry.js");
    await writeFile(entry, imports.join("\n"));
    const build = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      minify: true,
      metafile: true,
    });
    expect(build.success).toBe(true);
    await check(build);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("bundle generation refuses copied dependencies without reviewed notices", async () => {
  await fixture([{ name: "@fixture/unreviewed", license: "MIT" }], async (build) => {
    await expect(bundleLicenseBanner(build)).rejects.toThrow(
      "Add reviewed licence notices for bundled dependency @fixture/unreviewed@1.0.0",
    );
  });
});

test("upstream licence changes require renewed review before redistribution", async () => {
  await fixture([{ name: "paper", license: "Changed upstream licence" }], async (build) => {
    await expect(bundleLicenseBanner(build)).rejects.toThrow(
      "Bundled licence for paper@1.0.0 changed",
    );
  });
});

test("notices include full text once per shared licence and omit code removed from the bundle", async () => {
  const license = await Bun.file(
    new URL("../../../licenses/bundled/React.txt", import.meta.url),
  ).text();
  await fixture(
    [
      { name: "react-dom", license },
      { name: "react", license },
      { name: "@fixture/unused", license: "Unused", unused: true },
    ],
    async (build) => {
      const banner = await bundleLicenseBanner(build);
      expect(banner).toContain("react-dom@1.0.0, react@1.0.0");
      expect(banner).toContain(license.trim());
      expect(banner.match(/Copyright \(c\) Meta Platforms/g)).toHaveLength(1);
      expect(banner).not.toContain("@fixture/unused");
    },
  );
});

test("missing bundle metadata cannot silently omit required notices", async () => {
  await expect(bundleLicenseBanner({})).rejects.toThrow("requires build metadata");
});
