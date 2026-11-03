import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { resolveRepositoryLink, resolveRepositoryReference } from "./repository-link";

const root = join(homedir(), "file-navigation-project");
test("resolves relative, absolute, encoded and file URL references on the host", () => {
  for (const href of [
    "src/component.tsx:24:5",
    "./src/../src/component.tsx#L24C5",
    `${root}/src/component.tsx:24`,
    `file://${root}/src/component.tsx#L24-L30`,
    "~/file-navigation-project/src/component.tsx",
  ])
    expect(resolveRepositoryLink(root, href)).toBe("src/component.tsx");
  expect(resolveRepositoryLink(root, "src/a%20%231.ts:2")).toBe("src/a #1.ts");
});
test("rejects paths outside the selected checkout, metadata and unsafe destinations", () => {
  for (const href of [
    "../outside.ts",
    `${root}-other/file.ts`,
    "/etc/config.json",
    ".git/config.json",
    "src/../.git/config.json",
    "https://example.com/a.ts",
    "file://server/share/a.ts",
    "javascript:alert(1)",
  ])
    expect(() => resolveRepositoryLink(root, href)).toThrow();
});
test("absolute paths retain checkout identity rather than rebasing onto another worktree", () => {
  expect(() => resolveRepositoryLink(`${root}/worktree`, `${root}/src/a.ts`)).toThrow("outside");
  expect(resolveRepositoryLink(`${root}/worktree`, "src/a.ts")).toBe("src/a.ts");
});

test("absolute aliases open only when their real file stays inside the project", async () => {
  const scratch = await realpath(await mkdtemp(join(homedir(), ".tidy-file-alias-")));
  try {
    const project = join(scratch, "project");
    const alias = join(scratch, "alias");
    await mkdir(project);
    await writeFile(join(project, "name #1.ts"), "export const value = 1;");
    await symlink(project, alias);
    expect(await resolveRepositoryReference(project, `${alias}/name%20%231.ts:4`)).toBe(
      "name #1.ts",
    );
    const homeAlias = `~/${relative(homedir(), alias).split("\\").join("/")}`;
    expect(await resolveRepositoryReference(project, `${homeAlias}/name%20%231.ts:4`)).toBe(
      "name #1.ts",
    );
    await writeFile(join(scratch, "outside.ts"), "outside");
    await expect(resolveRepositoryReference(project, join(scratch, "outside.ts"))).rejects.toThrow(
      "outside",
    );
    await mkdir(join(project, ".git"));
    await writeFile(join(project, ".git/config.json"), "{}");
    await expect(
      resolveRepositoryReference(project, join(alias, ".git/config.json")),
    ).rejects.toThrow();
    await expect(
      resolveRepositoryReference(project, `${homeAlias}/.git/config.json`),
    ).rejects.toThrow();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
