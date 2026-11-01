import { z } from "zod";
import {
  projectSchema,
  threadSummarySchema,
  type Project,
  type ProjectSnapshot,
  type Bootstrap,
} from "../../../shared/contracts/desktop";

const cachedThreadSchema = threadSummarySchema.pick({
  id: true,
  projectId: true,
  revision: true,
  title: true,
  harness: true,
  actualModel: true,
  status: true,
  doneAt: true,
  updatedAt: true,
  pullRequests: true,
  messageCount: true,
});
const cacheSchema = z.object({
  projects: z.array(projectSchema).max(32),
  activeProject: z
    .object({
      project: projectSchema,
      threads: z.array(cachedThreadSchema).max(256),
    })
    .nullable(),
});
const entriesSchema = z.array(z.tuple([z.string().max(200), cacheSchema])).max(8);
const key = "tidy:sidebar-cache:v1";
type CacheStorage = Pick<Storage, "getItem" | "setItem">;
const parsedEntries = new WeakMap<
  CacheStorage,
  { raw: string; value: z.infer<typeof entriesSchema> }
>();

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function entries(target?: CacheStorage) {
  try {
    if (!target) return [];
    const raw = target.getItem(key) ?? "[]";
    const cached = parsedEntries.get(target);
    if (cached?.raw === raw) return cached.value;
    const value = entriesSchema.parse(JSON.parse(raw));
    parsedEntries.set(target, { raw, value });
    return value;
  } catch {
    return [];
  }
}

export function readSidebarCache(
  scope: string,
  target: CacheStorage | undefined = storage(),
): Pick<Bootstrap, "projects" | "activeProject"> | undefined {
  const cached = entries(target).find(([id]) => id === scope)?.[1];
  if (!cached) return undefined;
  const active = cached.activeProject;
  return {
    projects: structuredClone(cached.projects),
    activeProject: active
      ? ({
          project: structuredClone(active.project),
          threads: active.threads
            .filter((thread) => thread.projectId === active.project.id)
            .map((thread) => ({
              ...structuredClone(thread),
              designIds: [],
              status: thread.status === "running" ? ("interrupted" as const) : thread.status,
            })),
          designs: [],
          folders: [],
        } satisfies ProjectSnapshot)
      : null,
  };
}

export function writeSidebarCache(
  {
    scope,
    projects,
    activeProject,
  }: {
    scope: string;
    projects: Project[];
    activeProject: ProjectSnapshot | null;
  },
  target: CacheStorage | undefined = storage(),
) {
  try {
    const value = cacheSchema.parse({
      projects: projects.filter((project) => !project.cloud).slice(0, 32),
      activeProject:
        activeProject && !activeProject.project.cloud
          ? {
              project: activeProject.project,
              threads: activeProject.threads.slice(0, 256),
            }
          : null,
    });
    const next = entries(target).filter(([id]) => id !== scope);
    next.push([scope, value]);
    if (!target) return;
    const valueEntries = next.slice(-8);
    const raw = JSON.stringify(valueEntries);
    target.setItem(key, raw);
    parsedEntries.set(target, { raw, value: valueEntries });
  } catch {}
}
