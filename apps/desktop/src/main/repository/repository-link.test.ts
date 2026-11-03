import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRepositoryLink } from "./repository-link";

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
