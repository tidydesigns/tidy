import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportSource } from "./export-source.mjs";

function fixture(run) {
  const temporary = mkdtempSync(path.join(tmpdir(), "tidy-export-test-"));
  const repository = path.join(temporary, "source");
  mkdirSync(repository);
  const git = (...args) => execFileSync("git", args, { cwd: repository, stdio: "pipe" });
  git("init");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  try {
    run({ temporary, repository, git });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
test("export copies the reviewed commit without history, local secrets or uncommitted changes", () =>
  fixture(({ temporary, repository, git }) => {
    writeFileSync(path.join(repository, "README.md"), "reviewed source");
    writeFileSync(path.join(repository, ".gitignore"), ".env.local\nnode_modules/\n");
    git("add", ".");
    git("commit", "-m", "fixture");
    writeFileSync(path.join(repository, ".env.local"), "SECRET=must-stay-private");
    writeFileSync(path.join(repository, "README.md"), "unreviewed modification");
    const output = exportSource(repository, path.join(temporary, "public"));
    assert.equal(
      execFileSync("cat", [path.join(output, "README.md")], { encoding: "utf8" }),
      "reviewed source",
    );
    assert.equal(existsSync(path.join(output, ".git")), false);
    assert.equal(existsSync(path.join(output, ".env.local")), false);
    assert.throws(() => exportSource(repository, output), /must not exist/);
    assert.throws(() => exportSource(repository, path.join(repository, "out")), /outside/);
  }));
test("export refuses tracked secrets and cleans the failed destination", () =>
  fixture(({ temporary, repository, git }) => {
    writeFileSync(path.join(repository, ".env.local"), "SECRET=must-stay-private");
    git("add", ".");
    git("commit", "-m", "unsafe fixture");
    const output = path.join(temporary, "public");
    assert.throws(() => exportSource(repository, output), /Private or generated/);
    assert.equal(existsSync(output), false);
  }));
test("export refuses a symlink to files outside the source tree", () =>
  fixture(({ temporary, repository, git }) => {
    const secret = path.join(temporary, "operator-secret");
    writeFileSync(secret, "private");
    symlinkSync(secret, path.join(repository, "leak"));
    git("add", ".");
    git("commit", "-m", "unsafe symlink");
    assert.throws(() => exportSource(repository, path.join(temporary, "public")), /Symlinks/);
  }));
