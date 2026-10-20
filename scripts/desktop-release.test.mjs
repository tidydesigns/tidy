import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  publishDesktopBeta,
  releaseIdentity,
  validateReleaseArtifacts,
  writeReleaseMetadata,
} from "./desktop-release.mjs";

const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "push",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_REPOSITORY: "example/tidy",
  GITHUB_RUN_NUMBER: "41",
  GITHUB_RUN_ID: "123456",
  DESKTOP_BETA_VERSION_OFFSET: "1",
};
const identity = releaseIdentity({ version: "0.1.0-beta.1" }, environment);

/** Create a checked installer fixture and remove it after the test. */
async function candidate(t) {
  const directory = await mkdtemp(join(tmpdir(), "tidy-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await setInstaller(directory, Buffer.from("synthetic installer"));
  return directory;
}

/** Replace fixture bytes and regenerate their matching checksum and metadata. */
async function setInstaller(directory, bytes) {
  await writeFile(join(directory, identity.name), bytes);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(directory, `${identity.name}.sha256`), `${checksum}  ${identity.name}\n`);
  await writeReleaseMetadata(directory, identity);
}

/** Model a failed gh invocation with the exit code and stderr used by the publisher. */
function cliError(stderr) {
  return Object.assign(new Error(stderr), { code: 1, stderr });
}

/** Emulate release operations while retaining calls and assets for safety assertions. */
function fakeGitHub() {
  const state = {
    release: null,
    commit: null,
    tag: null,
    tags: new Map(),
    files: new Map(),
    calls: [],
    failUpload: false,
  };
  const gh = async (args) => {
    state.calls.push(args);
    if (args[0] === "api") {
      if (args[1] === `repos/${identity.repository}/git/ref/tags/${identity.tag}`) {
        if (!state.commit) throw cliError("gh: Not Found (HTTP 404)");
        return JSON.stringify({ object: state.tag ?? { type: "commit", sha: state.commit } });
      }
      const prefix = `repos/${identity.repository}/git/tags/`;
      if (args[1].startsWith(prefix)) {
        const object = state.tags.get(args[1].slice(prefix.length));
        if (!object) throw cliError("gh: Not Found (HTTP 404)");
        return JSON.stringify({ object });
      }
      throw new Error(`Unexpected API path: ${args[1]}`);
    }
    const option = (name) => args[args.indexOf(name) + 1];
    switch (args[1]) {
      case "view":
        if (!state.release) throw cliError("release not found");
        return JSON.stringify(state.release);
      case "create":
        assert.ok(args.includes("--draft"));
        assert.ok(args.includes("--prerelease"));
        assert.ok(args.includes("--latest=false"));
        assert.equal(option("--target"), identity.commit);
        state.commit = identity.commit;
        state.release = {
          tagName: identity.tag,
          targetCommitish: identity.commit,
          isDraft: true,
          isPrerelease: true,
          assets: [],
        };
        return "";
      case "upload":
        assert.equal(state.release.isDraft, true, "published releases must never be overwritten");
        if (state.failUpload) throw new Error("simulated interrupted upload");
        for (const path of args.slice(args.indexOf("--clobber") + 1))
          state.files.set(basename(path), await readFile(path));
        state.release.assets = [...state.files].map(([name, bytes]) => ({
          name,
          size: bytes.length,
        }));
        return "";
      case "edit":
        assert.equal(state.release.assets.length, 3, "all assets must exist before publication");
        assert.ok(
          state.calls.some((call) => call[1] === "download"),
          "remote assets must be read back before publication",
        );
        assert.ok(args.includes("--draft=false"));
        assert.ok(args.includes("--prerelease"));
        assert.ok(args.includes("--latest=false"));
        state.release.isDraft = false;
        return "";
      case "download":
        for (const [name, bytes] of state.files)
          await writeFile(join(option("--dir"), name), bytes);
        return "";
      default:
        throw new Error(`Unexpected CLI operation: ${args[0]} ${args[1]}`);
    }
  };
  return { state, gh };
}

test("beta identities are deterministic across retries and independent of web versions", () => {
  assert.equal(identity.version, "0.1.0-beta.42");
  assert.equal(identity.buildNumber, "42");
  assert.deepEqual(
    releaseIdentity({ version: "0.1.0-beta.999" }, { ...environment, GITHUB_RUN_ATTEMPT: "3" }),
    identity,
  );
  assert.equal(releaseIdentity({ version: "0.2.0" }, environment).version, "0.2.0-beta.42");
  assert.equal(
    releaseIdentity({ version: "0.1.0" }, { ...environment, DESKTOP_BETA_VERSION_OFFSET: "100" })
      .buildNumber,
    "141",
  );
});

test("the prepare CLI stamps only the disposable manifest and verifies its checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tidy-release-checkout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/desktop"), { recursive: true });
  const path = join(root, "apps/desktop/package.json");
  await writeFile(
    path,
    JSON.stringify({ name: "@tidy/desktop", version: "0.1.0-beta.1", desktopBuildNumber: "1" }),
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const env = { ...process.env, ...environment, GITHUB_SHA: git("rev-parse", "HEAD") };
  const command = fileURLToPath(new URL("./desktop-release.mjs", import.meta.url));
  const run = (override = {}) =>
    execFileSync(process.execPath, [command, "prepare"], {
      cwd: root,
      env: { ...env, ...override },
      stdio: "pipe",
    });
  run();
  const stamped = await readFile(path, "utf8");
  assert.deepEqual(JSON.parse(stamped), {
    name: "@tidy/desktop",
    version: "0.1.0-beta.42",
    desktopBuildNumber: "42",
  });
  run();
  assert.equal(await readFile(path, "utf8"), stamped);
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert.throws(() => run({ GITHUB_SHA: "b".repeat(40) }));
  assert.throws(() => run({ GITHUB_REF: "refs/heads/other" }));
  assert.equal(await readFile(path, "utf8"), stamped);
});

test("release identities reject PRs, other branches, malformed versions and output injection", () => {
  for (const change of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_REF: "refs/pull/1/merge" },
    { GITHUB_SHA: "main" },
    { GITHUB_REPOSITORY: "../../outside" },
    { GITHUB_RUN_NUMBER: "1\nmalicious=true" },
    { GITHUB_RUN_NUMBER: "0" },
    { DESKTOP_BETA_VERSION_OFFSET: "-1" },
    { DESKTOP_BETA_VERSION_OFFSET: "9999" },
    { GITHUB_RUN_ID: "NaN" },
  ])
    assert.throws(() => releaseIdentity({ version: "0.1.0" }, { ...environment, ...change }));
  for (const version of ["0.1.0-rc.1", "01.1.0", "0.1.0\ncommand", "0.1.0+metadata", "../x"])
    assert.throws(() => releaseIdentity({ version }, environment));
});

test("metadata binds the download URL, exact source, run and installer hash", async (t) => {
  const directory = await candidate(t);
  const metadata = await validateReleaseArtifacts(directory, identity);
  assert.equal(metadata.commit, identity.commit);
  assert.equal(metadata.downloads[0].url, identity.downloadUrl);
  assert.equal(metadata.downloads[0].size, (await lstat(join(directory, identity.name))).size);
  assert.equal(metadata.channel, "beta");
});

test("artifact tampering, unexpected files and symlinks stop publication before GitHub access", async (t) => {
  for (const change of ["bytes", "checksum", "metadata", "extra", "symlink"]) {
    const directory = await candidate(t);
    if (change === "bytes") await writeFile(join(directory, identity.name), "modified");
    if (change === "checksum")
      await writeFile(join(directory, `${identity.name}.sha256`), "bad checksum");
    if (change === "metadata") {
      const path = join(directory, "desktop-release.json");
      const metadata = JSON.parse(await readFile(path, "utf8"));
      metadata.commit = "b".repeat(40);
      await writeFile(path, JSON.stringify(metadata));
    }
    if (change === "extra")
      await writeFile(join(directory, "private.p12"), "must never be uploaded");
    if (change === "symlink") {
      const outside = `${directory}-outside`;
      await copyFile(join(directory, identity.name), outside);
      t.after(() => rm(outside, { force: true }));
      await rm(join(directory, identity.name));
      await symlink(outside, join(directory, identity.name));
    }
    const { state, gh } = fakeGitHub();
    await assert.rejects(publishDesktopBeta({ directory, identity, gh }));
    assert.equal(state.calls.length, 0);
  }
});

test("a release is published as a prerelease only after all assets are uploaded", async (t) => {
  const directory = await candidate(t);
  const { state, gh } = fakeGitHub();
  assert.deepEqual(await publishDesktopBeta({ directory, identity, gh }), {
    published: true,
    url: identity.releaseUrl,
  });
  assert.equal(state.release.isDraft, false);
  assert.equal(state.files.size, 3);
  const operations = state.calls.map((args) => args[1]);
  const publish = operations.indexOf("edit");
  assert.ok(operations.indexOf("download") < publish);
  assert.ok(operations.lastIndexOf("download") > publish);
});

test("same-size remote replacements must match the original local digests", async (t) => {
  for (const replaceAt of ["upload", "edit"]) {
    const directory = await candidate(t);
    const replacement = await candidate(t);
    const bytes = Buffer.from("synthetic installer");
    bytes[0] ^= 1;
    await setInstaller(replacement, bytes);
    const { state, gh: original } = fakeGitHub();
    const gh = async (args) => {
      if (args[1] === "edit" && replaceAt === "edit") {
        // Model another writer replacing the draft after its readback, before publication.
        for (const name of state.files.keys())
          state.files.set(name, await readFile(join(replacement, name)));
      }
      const result = await original(args);
      if (args[1] === "upload" && replaceAt === "upload") {
        // All three replacement files are self-consistent and retain their original sizes.
        for (const [name, previous] of state.files) {
          const next = await readFile(join(replacement, name));
          assert.equal(next.length, previous.length);
          state.files.set(name, next);
        }
      }
      return result;
    };
    await assert.rejects(
      publishDesktopBeta({ directory, identity, gh }),
      /Remote release assets differ/,
    );
    assert.equal(state.release.isDraft, replaceAt === "upload");
  }
});

test("publication cannot report success if its tag moves or disappears", async (t) => {
  for (const commit of ["b".repeat(40), null]) {
    const directory = await candidate(t);
    const { state, gh: original } = fakeGitHub();
    const gh = async (args) => {
      const result = await original(args);
      if (args[1] === "edit") state.commit = commit;
      return result;
    };
    await assert.rejects(publishDesktopBeta({ directory, identity, gh }));
    assert.equal(state.release.isDraft, false);
  }
});

test("annotated tags must resolve within five hops to the expected source commit", async (t) => {
  for (const { depth, commit, malformed, accepted } of [
    { depth: 1, commit: identity.commit, accepted: true },
    { depth: 5, commit: identity.commit, accepted: true },
    { depth: 1, commit: "b".repeat(40), accepted: false },
    { depth: 6, commit: identity.commit, accepted: false },
    { depth: 1, commit: identity.commit, malformed: true, accepted: false },
  ]) {
    const directory = await candidate(t);
    const { state, gh } = fakeGitHub();
    const hashes = Array.from({ length: depth }, (_, index) => String(index + 1).repeat(40));
    state.commit = identity.commit;
    state.tag = { type: "tag", sha: malformed ? "invalid-sha" : hashes[0] };
    for (let index = 0; index < depth; index++) {
      state.tags.set(
        hashes[index],
        index + 1 === depth
          ? { type: "commit", sha: commit }
          : { type: "tag", sha: hashes[index + 1] },
      );
    }
    if (accepted) {
      assert.equal((await publishDesktopBeta({ directory, identity, gh })).published, true);
    } else {
      await assert.rejects(publishDesktopBeta({ directory, identity, gh }), /release tag/i);
      assert.equal(state.release, null, "invalid tags must fail before creating a release");
    }
    const tagLookups = state.calls.filter(
      (args) => args[0] === "api" && args[1].startsWith(`repos/${identity.repository}/git/tags/`),
    );
    assert.equal(tagLookups.length > 0, !malformed);
  }
});

test("interrupted uploads remain private drafts and can be retried", async (t) => {
  const directory = await candidate(t);
  const { state, gh } = fakeGitHub();
  state.failUpload = true;
  await assert.rejects(publishDesktopBeta({ directory, identity, gh }), /interrupted upload/);
  assert.equal(state.release.isDraft, true);
  assert.ok(!state.calls.some((args) => args[1] === "edit"));
  state.failUpload = false;
  await publishDesktopBeta({ directory, identity, gh });
  assert.equal(state.calls.filter((args) => args[1] === "create").length, 1);
  assert.equal(state.release.isDraft, false);
});

test("reruns verify the existing published beta without replacing re-signed bytes", async (t) => {
  const directory = await candidate(t);
  const { state, gh } = fakeGitHub();
  await publishDesktopBeta({ directory, identity, gh });
  const publishedInstaller = state.files.get(identity.name);
  await setInstaller(directory, Buffer.from("a newly signed installer from the same commit"));
  state.calls = [];
  assert.equal((await publishDesktopBeta({ directory, identity, gh })).published, false);
  assert.equal(state.files.get(identity.name), publishedInstaller);
  assert.ok(!state.calls.some((args) => ["create", "upload", "edit"].includes(args[1])));
});

test("different source commits and stable releases cannot be overwritten or converted", async (t) => {
  const directory = await candidate(t);
  for (const kind of ["tag", "target", "stable", "incomplete"]) {
    const { state, gh } = fakeGitHub();
    await publishDesktopBeta({ directory, identity, gh });
    if (kind === "tag") state.commit = "b".repeat(40);
    if (kind === "target") state.release.targetCommitish = "b".repeat(40);
    if (kind === "stable") state.release.isPrerelease = false;
    if (kind === "incomplete") state.release.assets.pop();
    state.calls = [];
    await assert.rejects(publishDesktopBeta({ directory, identity, gh }));
    assert.ok(!state.calls.some((args) => ["create", "upload", "edit"].includes(args[1])));
  }
});

test("network/authentication errors are never interpreted as an absent release", async (t) => {
  const directory = await candidate(t);
  const { gh: original } = fakeGitHub();
  for (const operation of ["api", "view"]) {
    const gh = async (args) => {
      if (args[0] === operation || args[1] === operation)
        throw cliError("authentication or network failure");
      return original(args);
    };
    await assert.rejects(
      publishDesktopBeta({ directory, identity, gh }),
      /authentication or network failure/,
    );
  }
});
