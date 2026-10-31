import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Thread } from "../../shared/contracts/desktop";
import { chatImageSchema } from "../../shared/contracts/chat-images";
import { isRemoteMutation } from "../../shared/remote";
import { readChatImage } from "./chat-images";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import { createWorkspaceRequests } from "../ipc/workspace-requests";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1WQAAAAASUVORK5CYII=",
  "base64",
);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thread-images-"));
  directories.push(directory);
  const root = join(directory, "project");
  await mkdir(root);
  const thread: Thread = {
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    revision: 0,
    title: "Screenshot review",
    harness: "codex",
    designIds: [],
    messages: [],
    status: "completed",
    updatedAt: new Date().toISOString(),
  };
  function reference(href: string) {
    thread.messages = [
      { id: crypto.randomUUID(), role: "assistant", text: `![Screenshot](${href})` },
    ];
    return { root, thread, href };
  }
  return { directory, root, thread, reference };
}

test("host images support relative, absolute, encoded and file URL references outside the repository", async () => {
  const f = await fixture();
  const path = join(f.directory, "screen shot.png");
  await writeFile(path, png);
  await symlink(path, join(f.root, "linked.png"));
  for (const href of [path, pathToFileURL(path).href, "../screen%20shot.png", "linked.png"]) {
    const image = chatImageSchema.parse(await readChatImage(f.reference(href)));
    expect(image.dataUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
  }
  expect(isRemoteMutation("read-chat-image")).toBe(false);
});

test("image requests cannot read paths absent from the thread", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "private.png"), png);
  await expect(
    readChatImage({ root: f.root, thread: f.thread, href: "private.png" }),
  ).rejects.toThrow("not referenced");
});

test("renamed secrets, active formats, unsupported protocols, directories, missing and oversized files fail", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "secret.png"), "PRIVATE_KEY=secret");
  await writeFile(join(f.root, "vector.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(f.root, "huge.png"), png);
  await truncate(join(f.root, "huge.png"), 16 * 1024 * 1024 + 1);
  await mkdir(join(f.root, "folder.png"));
  for (const href of [
    "secret.png",
    "vector.svg",
    "huge.png",
    "folder.png",
    "missing.png",
    "file://server/screen.png",
    "https://example.org/screen.png",
    "data:text/html,secret",
    "javascript:alert(1)",
  ])
    await expect(readChatImage(f.reference(href))).rejects.toThrow();
});

test("the workspace request reads the owning host and validates thread and project identity", async () => {
  const f = await fixture();
  const store = new ProjectStore(join(f.directory, "state"));
  await store.initialize();
  const { project } = await store.open(f.root);
  const input = f.reference("screenshot.png");
  f.thread.projectId = project.id;
  await writeFile(join(f.root, "screenshot.png"), png);
  await store.writeThread(f.thread);
  const service = new WorkspaceService(store);
  const requests = createWorkspaceRequests(service, {
    chooseProject: async () => null,
    chooseDesign: async () => null,
    openExternal: async () => {
      throw new Error("Unexpected external action");
    },
    showItemInFolder: () => {
      throw new Error("Unexpected local file action");
    },
  });
  const request = { projectId: project.id, threadId: f.thread.id, href: input.href };
  try {
    expect(
      chatImageSchema.parse(await requests.invoke("read-chat-image", request, undefined)).dataUrl,
    ).toContain(png.toString("base64"));
    for (const invalid of [
      { ...request, projectId: crypto.randomUUID() },
      { ...request, threadId: crypto.randomUUID() },
      { ...request, extra: true },
      { ...request, href: "private.png" },
    ])
      await expect(requests.invoke("read-chat-image", invalid, undefined)).rejects.toThrow();
  } finally {
    await service.close();
  }
});
