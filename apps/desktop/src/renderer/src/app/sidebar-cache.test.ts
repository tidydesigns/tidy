import { expect, test } from "bun:test";
import { readSidebarCache, writeSidebarCache } from "./sidebar-cache";
import type { ProjectSnapshot, Thread } from "../../../shared/contracts/desktop";
import { summarizeThread } from "../../../shared/models/thread-updates";

function fixture() {
  let saved = "";
  const storage = {
    getItem: () => saved || null,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const project = {
    id: crypto.randomUUID(),
    name: "Project",
    path: "/project",
    openedAt: new Date().toISOString(),
  };
  const thread: Thread = {
    id: crypto.randomUUID(),
    projectId: project.id,
    revision: 4,
    title: "Review",
    harness: "codex",
    status: "running",
    designIds: [],
    updatedAt: project.openedAt,
    pullRequests: ["https://github.com/owner/repo/pull/42"],
    messages: [{ id: crypto.randomUUID(), role: "assistant", text: "Private transcript" }],
    pendingApprovals: [],
    activity: "Running command",
    sessionId: "private-session",
  };
  const activeProject: ProjectSnapshot = {
    project,
    threads: [{ ...summarizeThread(thread), pendingApprovalCount: 1 }],
    designs: [],
    folders: [],
  };
  return { storage, project, activeProject, saved: () => saved };
}

test("sidebar metadata survives reopening without transcripts or live authority", () => {
  const { storage, project, activeProject, saved } = fixture();
  writeSidebarCache({ scope: "machine", projects: [project], activeProject }, storage);
  const restored = readSidebarCache("machine", storage);
  expect(restored?.activeProject?.threads[0]).toMatchObject({
    title: "Review",
    pullRequests: activeProject.threads[0].pullRequests,
    status: "interrupted",
  });
  expect(restored?.activeProject?.threads[0].pendingApprovalCount).toBeUndefined();
  for (const field of [
    "Private transcript",
    "private-session",
    "Running command",
    "pendingApprovalCount",
    "sessionId",
  ])
    expect(saved()).not.toContain(field);
  expect(readSidebarCache("other-machine", storage)).toBeUndefined();
});

test("sidebar caching is bounded and authoritative clearing removes cached threads", () => {
  const { storage, project, activeProject } = fixture();
  activeProject.threads = Array.from({ length: 300 }, () => ({
    ...activeProject.threads[0],
    id: crypto.randomUUID(),
  }));
  for (let index = 0; index < 10; index++)
    writeSidebarCache({ scope: `machine-${index}`, projects: [project], activeProject }, storage);
  expect(readSidebarCache("machine-0", storage)).toBeUndefined();
  expect(readSidebarCache("machine-9", storage)?.activeProject?.threads).toHaveLength(256);
  writeSidebarCache({ scope: "machine-9", projects: [], activeProject: null }, storage);
  expect(readSidebarCache("machine-9", storage)).toEqual({ projects: [], activeProject: null });
});

test("malformed and blocked cache storage cannot stop workspace loading", () => {
  expect(readSidebarCache("", { getItem: () => "invalid", setItem() {} })).toBeUndefined();
  const storage = {
    getItem: () => {
      throw Error("Blocked");
    },
    setItem: () => {
      throw Error("Blocked");
    },
  };
  expect(readSidebarCache("", storage)).toBeUndefined();
  expect(() =>
    writeSidebarCache({ scope: "", projects: [], activeProject: null }, storage),
  ).not.toThrow();
});

test("cached sidebar reads remain isolated and observe another window's writes", () => {
  const { storage, project, activeProject } = fixture();
  writeSidebarCache({ scope: "machine", projects: [project], activeProject }, storage);
  const restored = readSidebarCache("machine", storage)!;
  restored.projects[0].name = "Changed by caller";
  restored.activeProject!.project.name = "Changed by caller";
  restored.activeProject!.threads[0].pullRequests!.push("https://github.com/owner/repo/pull/99");
  expect(readSidebarCache("machine", storage)?.projects[0].name).toBe("Project");
  expect(readSidebarCache("machine", storage)?.activeProject?.project.name).toBe("Project");
  expect(readSidebarCache("machine", storage)?.activeProject?.threads[0].pullRequests).toHaveLength(
    1,
  );
  activeProject.threads[0].title = "Changed in another window";
  writeSidebarCache({ scope: "machine", projects: [project], activeProject }, { ...storage });
  expect(readSidebarCache("machine", storage)?.activeProject?.threads[0].title).toBe(
    "Changed in another window",
  );
});

test("failed sidebar cache writes do not become remembered entries", () => {
  const { storage, project, activeProject } = fixture();
  let blocked = false;
  const target = {
    getItem: storage.getItem,
    setItem: (key: string, value: string) => {
      if (blocked) throw Error("Quota exceeded");
      storage.setItem(key, value);
    },
  };
  writeSidebarCache({ scope: "machine", projects: [project], activeProject }, target);
  blocked = true;
  writeSidebarCache({ scope: "failed", projects: [project], activeProject }, target);
  expect(readSidebarCache("failed", target)).toBeUndefined();
  blocked = false;
  writeSidebarCache({ scope: "next", projects: [project], activeProject }, target);
  expect(readSidebarCache("machine", target)?.activeProject?.threads).toHaveLength(1);
  expect(readSidebarCache("failed", target)).toBeUndefined();
  expect(readSidebarCache("next", target)?.activeProject?.threads).toHaveLength(1);
});
