import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDiskImage } from "./disk-image";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "disk image test-"));
  roots.push(root);
  const sourceDirectory = join(root, "contents");
  await mkdir(sourceDirectory);
  return {
    root,
    sourceDirectory,
    outputPath: join(root, "Installer.dmg"),
    volumeName: "Tidy Fixture (Beta)",
  };
}

const busy = () =>
  Object.assign(new Error("hdiutil failed"), {
    code: 1,
    stderr: "hdiutil: create failed - Resource busy\n",
    killed: false,
    signal: null,
  });

test("disk images replace the candidate only after successful verification", async () => {
  const f = await fixture();
  await writeFile(f.outputPath, "previous");
  await writeFile(join(f.sourceDirectory, "keep.txt"), "source");
  const calls: string[][] = [];
  const waits: number[] = [];
  await createDiskImage(f, {
    run: async (args) => {
      calls.push(args);
      if (args[0] === "create") await writeFile(args[args.length - 1], "verified image");
      else {
        expect(args[0]).toBe("verify");
        expect(await readFile(args[1], "utf8")).toBe("verified image");
        expect(await readFile(f.outputPath, "utf8")).toBe("previous");
      }
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  expect(calls[0].slice(0, 7)).toEqual([
    "create",
    "-volname",
    f.volumeName,
    "-srcfolder",
    f.sourceDirectory,
    "-format",
    "UDZO",
  ]);
  expect(calls.map((args) => args[0])).toEqual(["create", "verify"]);
  expect(waits).toEqual([]);
  expect(await readFile(f.outputPath, "utf8")).toBe("verified image");
  expect(await readFile(join(f.sourceDirectory, "keep.txt"), "utf8")).toBe("source");
  expect((await readdir(f.root)).sort()).toEqual(["Installer.dmg", "contents"]);
});

test("resource-busy retries use new output paths and discard all partial images", async () => {
  const f = await fixture();
  const paths: string[] = [];
  const waits: number[] = [];
  await createDiskImage(f, {
    run: async (args) => {
      if (args[0] === "verify") {
        expect(args[1]).toBe(paths[3]);
        return;
      }
      const image = args[args.length - 1];
      paths.push(image);
      await writeFile(image, paths.length < 4 ? "partial" : "complete");
      if (paths.length < 4) throw busy();
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  expect(new Set(paths).size).toBe(4);
  expect(waits).toEqual([5_000, 15_000, 30_000]);
  expect(await readFile(f.outputPath, "utf8")).toBe("complete");
  expect((await readdir(f.root)).sort()).toEqual(["Installer.dmg", "contents"]);
});

test("exhausted retries preserve the previous candidate and propagate the final failure", async () => {
  const f = await fixture();
  await writeFile(f.outputPath, "previous");
  const failures = Array.from({ length: 4 }, busy);
  let attempts = 0;
  const waits: number[] = [];
  await expect(
    createDiskImage(f, {
      run: async (args) => {
        await writeFile(args[args.length - 1], "partial");
        throw failures[attempts++];
      },
      wait: async (ms) => {
        waits.push(ms);
      },
    }),
  ).rejects.toBe(failures[3]);
  expect(attempts).toBe(4);
  expect(waits).toEqual([5_000, 15_000, 30_000]);
  expect(await readFile(f.outputPath, "utf8")).toBe("previous");
  expect((await readdir(f.root)).sort()).toEqual(["Installer.dmg", "contents"]);
});

test.each([
  { code: 1, stderr: "hdiutil: create failed - No space left on device" },
  { code: 1, stderr: "hdiutil: create failed - Permission denied" },
  { code: 1, stderr: "hdiutil: create failed - Invalid argument" },
  { code: 1, stderr: "hdiutil: verify failed - Resource busy" },
  { code: 16, stderr: "hdiutil: create failed - Resource busy" },
  { code: "ENOENT", stderr: "" },
  { code: 1, stderr: "hdiutil: create failed - Resource busy", killed: true },
  { code: 1, stderr: "hdiutil: create failed - Resource busy", signal: "SIGTERM" },
])("other tool failures stop without retrying: %j", async (details) => {
  const f = await fixture();
  const failure = Object.assign(new Error("hdiutil failed"), details);
  let attempts = 0;
  const waits: number[] = [];
  await expect(
    createDiskImage(f, {
      run: async () => {
        attempts++;
        throw failure;
      },
      wait: async (ms) => {
        waits.push(ms);
      },
    }),
  ).rejects.toBe(failure);
  expect(attempts).toBe(1);
  expect(waits).toEqual([]);
  expect(await readdir(f.root)).toEqual(["contents"]);
});

test("verification failures never retry creation or replace the candidate", async () => {
  const f = await fixture();
  await writeFile(f.outputPath, "previous");
  const failure = busy();
  const calls: string[] = [];
  await expect(
    createDiskImage(f, {
      run: async (args) => {
        calls.push(args[0]);
        if (args[0] === "create") await writeFile(args[args.length - 1], "unverified");
        else throw failure;
      },
      wait: async () => {
        throw new Error("Verification must not retry");
      },
    }),
  ).rejects.toBe(failure);
  expect(calls).toEqual(["create", "verify"]);
  expect(await readFile(f.outputPath, "utf8")).toBe("previous");
  expect((await readdir(f.root)).sort()).toEqual(["Installer.dmg", "contents"]);
});

test.skipIf(process.platform !== "darwin")(
  "native disk images preserve payloads and installation symlinks",
  async () => {
    const f = await fixture();
    const framework = "Fixture.app/Contents/Frameworks/Fixture.framework";
    await mkdir(join(f.sourceDirectory, framework, "Versions/A"), { recursive: true });
    await writeFile(join(f.sourceDirectory, framework, "Versions/A/Fixture"), "payload");
    await symlink("A", join(f.sourceDirectory, framework, "Versions/Current"));
    await symlink("Versions/Current/Fixture", join(f.sourceDirectory, framework, "Fixture"));
    await symlink("/Applications", join(f.sourceDirectory, "Applications"));
    await createDiskImage(f);
    const execute = promisify(execFile);
    const mount = join(f.root, "mounted");
    await mkdir(mount);
    await execute(
      "/usr/bin/hdiutil",
      ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, f.outputPath],
      { timeout: 30_000 },
    );
    try {
      expect(await readFile(join(mount, framework, "Fixture"), "utf8")).toBe("payload");
      expect(await readlink(join(mount, framework, "Versions/Current"))).toBe("A");
      expect(await readlink(join(mount, "Applications"))).toBe("/Applications");
    } finally {
      await execute("/usr/bin/hdiutil", ["detach", "-force", mount], { timeout: 30_000 });
    }
  },
  180_000,
);
