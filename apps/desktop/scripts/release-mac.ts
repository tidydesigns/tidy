import { sign } from "@electron/osx-sign";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import manifest from "../package.json";
import { packageDesktop } from "./package";

const execute = promisify(execFile);
const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const identity = process.env.TIDY_MAC_SIGN_IDENTITY?.trim();
const profile = process.env.TIDY_NOTARY_PROFILE?.trim();

if (process.platform !== "darwin") throw new Error("macOS releases must be built on macOS.");
if (!identity?.startsWith("Developer ID Application:"))
  throw new Error("Set TIDY_MAC_SIGN_IDENTITY to your Developer ID Application identity name.");
if (!profile)
  throw new Error("Set TIDY_NOTARY_PROFILE to a validated notarytool Keychain profile.");

async function run(command: string, args: string[]) {
  const result = await execute(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout;
}

// Resource files are sealed by their containing bundle, not individually signed.
// Sign every Mach-O (including universal binaries), regardless of its extension.
function isResource(path: string) {
  if (!statSync(path).isFile()) return false;
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, 4, 0) !== 4) return true;
    return ![
      0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
      0xbfbafeca,
    ].includes(header.readUInt32BE());
  } finally {
    closeSync(descriptor);
  }
}

async function notarize(path: string) {
  console.info(`Submitting ${basename(path)} for notarization…`);
  const submission = JSON.parse(
    await run("xcrun", [
      "notarytool",
      "submit",
      path,
      "--keychain-profile",
      profile!,
      "--output-format",
      "json",
    ]),
  ) as { id: string };
  console.info(`Notarization submission: ${submission.id}`);
  const result = JSON.parse(
    await run("xcrun", [
      "notarytool",
      "wait",
      submission.id,
      "--keychain-profile",
      profile!,
      "--timeout",
      "15m",
      "--output-format",
      "json",
    ]),
  ) as { status: string };
  if (result.status !== "Accepted")
    throw new Error(
      `Notarization ${result.status}: inspect submission ${submission.id} with notarytool log.`,
    );
}

// Fail before packaging if credentials are unavailable. No passwords enter this process.
await run("xcrun", [
  "notarytool",
  "history",
  "--keychain-profile",
  profile,
  "--output-format",
  "json",
]);
const paths = await packageDesktop();
if (paths.length !== 1) throw new Error("Expected one native-architecture macOS package.");
const app = join(paths[0], "Tidy.app");
const temporary = await mkdtemp(join(tmpdir(), "tidy-release-"));
const artifactName = `Tidy-${manifest.version}-mac-${process.arch}.dmg`;
const artifact = join(appDirectory, "release", artifactName);

try {
  // packageDesktop applies the security fuses first; signing must be the final bundle mutation.
  console.info(`Signing Tidy ${manifest.version} (${process.arch})…`);
  await sign({
    app,
    identity,
    platform: "darwin",
    version: manifest.devDependencies.electron,
    preEmbedProvisioningProfile: false,
    ignore: isResource,
    optionsForFile: () => ({
      hardenedRuntime: true,
      entitlements: ["com.apple.security.cs.allow-jit"],
    }),
  });
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);

  const archive = join(temporary, "Tidy.zip");
  await run("ditto", ["-c", "-k", "--keepParent", app, archive]);
  await notarize(archive);
  await run("xcrun", ["stapler", "staple", app]);
  await run("xcrun", ["stapler", "validate", app]);
  await run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);

  const contents = join(temporary, "contents");
  await cp(app, join(contents, "Tidy.app"), { recursive: true });
  await symlink("/Applications", join(contents, "Applications"));
  await run("hdiutil", [
    "create",
    "-volname",
    `Tidy ${manifest.version}`,
    "-srcfolder",
    contents,
    "-format",
    "UDZO",
    "-ov",
    artifact,
  ]);
  await run("codesign", ["--sign", identity, "--timestamp", artifact]);
  await notarize(artifact);
  await run("xcrun", ["stapler", "staple", artifact]);
  await run("xcrun", ["stapler", "validate", artifact]);
  await run("codesign", ["--verify", "--strict", artifact]);
  await run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=2",
    artifact,
  ]);

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  await writeFile(`${artifact}.sha256`, `${hash.digest("hex")}  ${artifactName}\n`);
  console.info(`Verified release candidate: ${artifact}`);
  console.info("App and DMG are signed, notarized and stapled. Nothing has been published.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
