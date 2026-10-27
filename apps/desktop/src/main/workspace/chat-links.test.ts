import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseChatLink } from "../../shared/models/chat-links";
import { openChatLink, openRemoteChatLink } from "./chat-links";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import { createWorkspaceRequests } from "../ipc/workspace-requests";

const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});

test("service badges use the destination hostname, never labels or lookalike hosts", () => {
  expect(parseChatLink("https://github.com/owner/repo/pull/42")?.kind).toBe("external");
  for (const [href, service] of [
    ["https://GITHUB.com/owner/repo", "github"],
    ["https://gist.github.com/owner/123", "github"],
    ["https://gitlab.com/owner/repo", "gitlab"],
    ["https://www.figma.com/design/123", "figma"],
    ["https://www.notion.so/page", "notion"],
    ["https://www.npmjs.com/package/react", "npm"],
    ["https://linear.app/team/issue/123", "linear"],
    ["https://github.com.example.org/repo", null],
    ["https://example.org/github.com", null],
    ["https://notgithub.com/", null],
  ])
    expect(parseChatLink(href ?? undefined)).toMatchObject({ kind: "external", service });
  expect(parseChatLink("https://github.com@example.org/repo")).toBeNull();
});

test("file links preserve spaces, Windows paths, line positions, and encoded filename characters", () => {
  expect(parseChatLink("button.tsx:24")).toEqual({
    kind: "file",
    path: "button.tsx",
    name: "button.tsx",
    line: 24,
  });
  expect(parseChatLink("/project/src/button.tsx:24:5")).toEqual({
    kind: "file",
    path: "/project/src/button.tsx",
    name: "button.tsx",
    line: 24,
    column: 5,
  });
  expect(parseChatLink("src/button.tsx#L24-L28")).toEqual({
    kind: "file",
    path: "src/button.tsx",
    name: "button.tsx",
    line: 24,
  });
  expect(parseChatLink("file:///project/My%20files/a%23b.ts#L2")).toEqual({
    kind: "file",
    path: "/project/My files/a#b.ts",
    name: "a#b.ts",
    line: 2,
  });
  expect(parseChatLink("C:\\project\\button.tsx:24")).toMatchObject({
    kind: "file",
    path: "C:/project/button.tsx",
    line: 24,
  });
  expect(parseChatLink("file:///C:/project/button.tsx:24")).toMatchObject({
    kind: "file",
    path: "C:/project/button.tsx",
    line: 24,
  });
  expect(parseChatLink("./Dockerfile")).toMatchObject({ kind: "file", name: "Dockerfile" });
});

test("unsupported protocols, network files, malformed escapes, and control characters stay inert", () => {
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,test",
    "vscode://file/project/a.ts",
    "file://server/share/a.ts",
    "//server/a.ts",
    "\\\\server\\a.ts",
    "https://github.com/\nrepo",
    "a%00.ts",
    "a%0a.ts",
    "a%ZZ.ts",
    "#section",
    "src/a.ts:999999999999999999999",
    "src/a.ts?run=true",
    "not a reference",
  ])
    expect(parseChatLink(href)).toBeNull();
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tidy-chat-links-")));
  cleanups.push(directory);
  const root = join(directory, "project");
  await mkdir(root);
  const file = join(root, "button #1.tsx");
  await writeFile(file, "export const Button = () => null;");
  const opened: string[] = [];
  const revealed: string[] = [];
  const platform = {
    openExternal: async (url: string) => {
      opened.push(url);
    },
    showItemInFolder: (path: string) => {
      revealed.push(path);
    },
    chooseProject: async () => root,
    chooseDesign: async () => null,
  };
  return { directory, root, file, opened, revealed, platform };
}

test("opening a file resolves it within the project and strips navigation positions", async () => {
  const f = await fixture();
  await openChatLink({ ...f, href: `${pathToFileURL(f.file)}#L24` });
  await openChatLink({ ...f, href: "button%20%231.tsx:3" });
  expect(f.revealed).toEqual([f.file, f.file]);
  expect(f.opened).toEqual([]);
});

test("file traversal and symlink escapes cannot cross the project boundary", async () => {
  const f = await fixture();
  const outside = join(f.directory, "private.ts");
  await writeFile(outside, "private");
  await symlink(outside, join(f.root, "linked.ts"));
  await mkdir(join(f.root, "folder.ts"));
  for (const href of [
    "../private.ts",
    "..%2fprivate.ts",
    outside,
    "linked.ts",
    "folder.ts",
    "missing.ts",
  ])
    await expect(openChatLink({ ...f, href })).rejects.toThrow();
  expect(f.revealed).toEqual([]);
  expect(f.opened).toEqual([]);
});

test("the workspace bridge validates project identity and rejects extra request fields", async () => {
  const f = await fixture();
  const store = new ProjectStore(join(f.directory, "state"));
  await store.initialize();
  const snapshot = await store.open(f.root);
  const service = new WorkspaceService(store);
  const requests = createWorkspaceRequests(service, f.platform);
  const input = { projectId: snapshot.project.id, href: "https://github.com/owner/repo/pull/42" };
  try {
    await requests.invoke("open-chat-link", input, undefined);
    expect(f.opened).toEqual([input.href]);
    await expect(
      requests.invoke("open-chat-link", { ...input, href: "javascript:alert(1)" }, undefined),
    ).rejects.toThrow();
    await expect(
      requests.invoke("open-chat-link", { ...input, projectId: crypto.randomUUID() }, undefined),
    ).rejects.toThrow();
    await expect(
      requests.invoke("open-chat-link", { ...input, command: "run" }, undefined),
    ).rejects.toThrow();
    expect(f.opened).toEqual([input.href]);
  } finally {
    await service.close();
  }
});

test("remote web links open on the desktop without resolving a local project or file", async () => {
  const f = await fixture();
  for (const href of ["https://example.org/review", "mailto:hello@example.org"]) {
    await openRemoteChatLink({
      input: { projectId: crypto.randomUUID(), href },
      platform: f.platform,
    });
  }
  expect(f.opened).toEqual(["https://example.org/review", "mailto:hello@example.org"]);
  expect(f.revealed).toEqual([]);
});

test("remote chat links cannot reveal local files or launch unsupported protocols", async () => {
  const f = await fixture();
  for (const href of [
    f.file,
    "button.tsx:3",
    "file:///etc/passwd",
    "../private.ts",
    "javascript:alert(1)",
    "data:text/html,test",
    "vscode://file/project/a.ts",
    "https://user:secret@example.org",
  ]) {
    await expect(
      openRemoteChatLink({ input: { projectId: crypto.randomUUID(), href }, platform: f.platform }),
    ).rejects.toThrow();
  }
  for (const input of [
    null,
    { projectId: "invalid", href: "https://example.org" },
    { projectId: crypto.randomUUID(), href: "https://example.org", extra: true },
  ]) {
    await expect(openRemoteChatLink({ input, platform: f.platform })).rejects.toThrow();
  }
  expect(f.opened).toEqual([]);
  expect(f.revealed).toEqual([]);
});
