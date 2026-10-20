import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const execute = promisify(execFile);
const manifestName = "desktop-release.json";
const versionPart = "(?:0|[1-9][0-9]*)";
const basePattern = new RegExp(
  `^(${versionPart}\\.${versionPart}\\.${versionPart})(?:-beta\\.[1-9][0-9]*)?$`,
);

/** Parse a canonical decimal integer, rejecting unsafe values and values below the minimum. */
function integer(value, name, minimum = 1) {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? "")) throw new Error(`Invalid ${name}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`Invalid ${name}.`);
  return number;
}

/** Derive a retry-stable beta identity from a validated main-branch Actions context. */
export function releaseIdentity(manifest, env) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME)
  )
    throw new Error("Desktop beta releases require a main-branch push or manual Actions run.");
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")) throw new Error("Invalid source commit.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(env.GITHUB_REPOSITORY ?? ""))
    throw new Error("Invalid GitHub repository.");
  const base = basePattern.exec(manifest.version)?.[1];
  if (!base) throw new Error("Desktop version must be a release version or numbered beta.");
  const sequence =
    integer(env.GITHUB_RUN_NUMBER, "run number") +
    integer(env.DESKTOP_BETA_VERSION_OFFSET ?? "1", "version offset", 0);
  // CFBundleVersion's first component has at most four digits.
  if (!Number.isSafeInteger(sequence) || sequence > 9999)
    throw new Error("Beta build number exceeds 9999.");
  integer(env.GITHUB_RUN_ID, "run ID");
  const version = `${base}-beta.${sequence}`;
  const tag = `desktop-v${version}`;
  const name = `Tidy-${version}-mac-arm64.dmg`;
  return {
    version,
    buildNumber: String(sequence),
    tag,
    name,
    repository: env.GITHUB_REPOSITORY,
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    releaseUrl: `https://github.com/${env.GITHUB_REPOSITORY}/releases/tag/${tag}`,
    downloadUrl: `https://github.com/${env.GITHUB_REPOSITORY}/releases/download/${tag}/${name}`,
  };
}

/** Return file metadata only for regular files; reject symlinks and other entry types. */
async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Release inputs must be regular files.");
  return info;
}

/** Stream a regular release file into a SHA-256 digest without loading it all into memory. */
async function sha256(path) {
  await regularFile(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Validate the nonempty installer and exact checksum sidecar, then describe its download. */
async function checkedDownload(directory, identity) {
  const path = join(directory, identity.name);
  const info = await regularFile(path);
  if (info.size === 0) throw new Error("Empty desktop installer.");
  const digest = await sha256(path);
  const checksumPath = `${path}.sha256`;
  await regularFile(checksumPath);
  const checksum = await readFile(checksumPath, "utf8");
  if (checksum !== `${digest}  ${identity.name}\n`) throw new Error("Installer checksum mismatch.");
  return {
    platform: "darwin",
    arch: "arm64",
    name: identity.name,
    url: identity.downloadUrl,
    sha256: digest,
    size: info.size,
  };
}

/** Write public metadata binding a verified installer to its source commit and workflow run. */
export async function writeReleaseMetadata(directory, identity) {
  const download = await checkedDownload(directory, identity);
  const metadata = {
    schemaVersion: 1,
    channel: "beta",
    version: identity.version,
    buildNumber: identity.buildNumber,
    tag: identity.tag,
    repository: identity.repository,
    commit: identity.commit,
    runId: identity.runId,
    releaseUrl: identity.releaseUrl,
    downloads: [download],
  };
  await writeFile(join(directory, manifestName), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

/** Reject extra files, symlinks, tampered bytes, or metadata that differs from this release. */
export async function validateReleaseArtifacts(directory, identity) {
  const names = [identity.name, `${identity.name}.sha256`, manifestName].sort();
  const entries = (await readdir(directory)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(names))
    throw new Error("Unexpected release artifact set.");
  const path = join(directory, manifestName);
  await regularFile(path);
  const metadata = JSON.parse(await readFile(path, "utf8"));
  const expected = {
    schemaVersion: 1,
    channel: "beta",
    version: identity.version,
    buildNumber: identity.buildNumber,
    tag: identity.tag,
    repository: identity.repository,
    commit: identity.commit,
    runId: identity.runId,
    releaseUrl: identity.releaseUrl,
    downloads: [await checkedDownload(directory, identity)],
  };
  // Compare parsed values without trusting property order or allowing extra metadata.
  if (!isDeepStrictEqual(metadata, expected))
    throw new Error("Release metadata does not match this workflow run and installer.");
  return expected;
}

/** Execute gh with literal arguments and propagate failures to the caller. */
async function runGh(args) {
  const result = await execute("gh", args, { maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}

/** Read a release, returning null only for gh's explicit release-not-found response. */
async function getRelease(identity, gh) {
  try {
    return JSON.parse(
      await gh([
        "release",
        "view",
        identity.tag,
        "--repo",
        identity.repository,
        "--json",
        "tagName,targetCommitish,isDraft,isPrerelease,assets,url",
      ]),
    );
  } catch (error) {
    if (error.code === 1 && error.stderr?.trim() === "release not found") return null;
    throw error;
  }
}

/** Resolve up to five annotated tags to the expected commit; require a tag after publication. */
async function checkTag(identity, gh, required = false) {
  let object;
  try {
    object = JSON.parse(
      await gh(["api", `repos/${identity.repository}/git/ref/tags/${identity.tag}`]),
    ).object;
  } catch (error) {
    if (!required && error.code === 1 && /\(HTTP 404\)/.test(error.stderr ?? "")) return;
    throw error;
  }
  for (let depth = 0; depth < 5 && object?.type === "tag"; depth++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new Error("Invalid annotated release tag.");
    object = JSON.parse(
      await gh(["api", `repos/${identity.repository}/git/tags/${object.sha}`]),
    ).object;
  }
  if (object?.type !== "commit" || object.sha !== identity.commit)
    throw new Error("Release tag points to a different source commit.");
}

/** Read back all remote assets into a fresh directory and compare their exact local digests. */
async function checkRemoteArtifacts(temporary, identity, gh, digests) {
  const directory = await mkdtemp(join(temporary, "verify-"));
  await gh([
    "release",
    "download",
    identity.tag,
    "--repo",
    identity.repository,
    "--dir",
    directory,
  ]);
  await validateReleaseArtifacts(directory, identity);
  for (const [name, digest] of digests) {
    if ((await sha256(join(directory, name))) !== digest)
      throw new Error("Remote release assets differ from the verified local artifacts.");
  }
}

/** Require an existing release to be a desktop prerelease targeting this exact commit. */
function checkRelease(release, identity) {
  if (
    release.tagName !== identity.tag ||
    release.targetCommitish !== identity.commit ||
    release.isPrerelease !== true ||
    typeof release.isDraft !== "boolean"
  )
    throw new Error("Existing release is not this commit's desktop beta.");
}

/** Stage and publish verified beta assets, recovering drafts without replacing published bytes. */
export async function publishDesktopBeta({ directory, identity, gh = runGh }) {
  await validateReleaseArtifacts(directory, identity);
  const digests = await Promise.all(
    [identity.name, `${identity.name}.sha256`, manifestName].map(async (name) => [
      name,
      await sha256(join(directory, name)),
    ]),
  );
  await checkTag(identity, gh);
  let release = await getRelease(identity, gh);
  const temporary = await mkdtemp(join(tmpdir(), "tidy-beta-publish-"));
  try {
    if (release) {
      checkRelease(release, identity);
      if (!release.isDraft) {
        // A retry must never replace a published installer, even if re-signing changed its bytes.
        const expectedNames = [identity.name, `${identity.name}.sha256`, manifestName].sort();
        if (
          JSON.stringify(release.assets.map((asset) => asset.name).sort()) !==
          JSON.stringify(expectedNames)
        )
          throw new Error("Published beta has an incomplete or unexpected asset set.");
        await gh([
          "release",
          "download",
          identity.tag,
          "--repo",
          identity.repository,
          "--dir",
          temporary,
          ...expectedNames.flatMap((name) => ["--pattern", name]),
        ]);
        await validateReleaseArtifacts(temporary, identity);
        await checkTag(identity, gh, true);
        return { published: false, url: identity.releaseUrl };
      }
      if (
        release.assets.some(
          (asset) => ![identity.name, `${identity.name}.sha256`, manifestName].includes(asset.name),
        )
      )
        throw new Error("Draft contains unexpected release assets.");
    }
    const notes = join(temporary, "notes.md");
    await writeFile(
      notes,
      [
        `Tidy desktop ${identity.version}`,
        "",
        "Public beta for Apple Silicon Macs.",
        "Download the DMG, open it, and drag Tidy into Applications. This beta uses manual updates.",
        "",
        `Source: https://github.com/${identity.repository}/commit/${identity.commit}`,
        `Build: https://github.com/${identity.repository}/actions/runs/${identity.runId}`,
        "",
      ].join("\n"),
    );
    if (!release) {
      await gh([
        "release",
        "create",
        identity.tag,
        "--repo",
        identity.repository,
        "--target",
        identity.commit,
        "--draft",
        "--prerelease",
        "--latest=false",
        "--title",
        `Tidy desktop ${identity.version}`,
        "--notes-file",
        notes,
      ]);
    }
    release = await getRelease(identity, gh);
    if (!release) throw new Error("Release draft was not created.");
    checkRelease(release, identity);
    if (!release.isDraft)
      throw new Error("Release was published by another process; refusing to change it.");
    await gh([
      "release",
      "upload",
      identity.tag,
      "--repo",
      identity.repository,
      "--clobber",
      ...[identity.name, `${identity.name}.sha256`, manifestName].map((name) =>
        join(directory, name),
      ),
    ]);
    release = await getRelease(identity, gh);
    if (!release) throw new Error("Release draft disappeared.");
    checkRelease(release, identity);
    const expectedFiles = [identity.name, `${identity.name}.sha256`, manifestName];
    if (!release.isDraft || release.assets.length !== expectedFiles.length)
      throw new Error("Draft asset set is incomplete or release is already published.");
    for (const name of expectedFiles) {
      const asset = release.assets.find((item) => item.name === name);
      if (!asset || asset.size !== (await regularFile(join(directory, name))).size)
        throw new Error("Uploaded asset size mismatch.");
    }
    await checkRemoteArtifacts(temporary, identity, gh, digests);
    await checkTag(identity, gh);
    await gh([
      "release",
      "edit",
      identity.tag,
      "--repo",
      identity.repository,
      "--draft=false",
      "--prerelease",
      "--latest=false",
      "--target",
      identity.commit,
      "--title",
      `Tidy desktop ${identity.version}`,
      "--notes-file",
      notes,
    ]);
    release = await getRelease(identity, gh);
    if (!release) throw new Error("Published release disappeared.");
    checkRelease(release, identity);
    if (release.isDraft) throw new Error("Release is still a draft.");
    await checkRemoteArtifacts(temporary, identity, gh, digests);
    await checkTag(identity, gh, true);
    return { published: true, url: identity.releaseUrl };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = resolve("apps/desktop/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const identity = releaseIdentity(manifest, process.env);
  const head = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
  if (head !== identity.commit) throw new Error("Checkout differs from the release source commit.");
  const directory = resolve(process.argv[3] ?? "apps/desktop/release");
  switch (process.argv[2]) {
    case "prepare":
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...manifest, version: identity.version, desktopBuildNumber: identity.buildNumber }, null, 2)}\n`,
      );
      console.info(`Prepared ${identity.version} from ${identity.commit}.`);
      break;
    case "metadata":
      if (process.platform !== "darwin" || process.arch !== "arm64")
        throw new Error("Expected an Apple Silicon macOS builder.");
      await writeReleaseMetadata(directory, identity);
      break;
    case "publish": {
      if (!process.env.GH_TOKEN)
        throw new Error("Publishing requires the job-scoped GitHub token.");
      console.info(JSON.stringify(await publishDesktopBeta({ directory, identity })));
      break;
    }
    default:
      throw new Error(
        "Usage: node scripts/desktop-release.mjs prepare|metadata|publish [artifact-directory]",
      );
  }
}
