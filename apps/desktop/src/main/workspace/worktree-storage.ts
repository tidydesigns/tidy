import { z } from "zod";
import type { ProjectStore } from "./project-store";
import { threadWorktreeSchema } from "../../shared/contracts/thread-workspace";
import type { ThreadSummary } from "../../shared/contracts/desktop";

export const managedWorktreeSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  executionProjectId: z.uuid(),
  projectPath: z.string(),
  title: z.string(),
  worktree: threadWorktreeSchema,
  createdAt: z.string().datetime(),
});
export type ManagedWorktree = z.infer<typeof managedWorktreeSchema>;

/** Private receipts prove ownership even after a thread file is deleted. */
export class WorktreeStorage {
  private writes = Promise.resolve();
  constructor(private store: ProjectStore) {}
  async records(): Promise<ManagedWorktree[]> {
    return z
      .array(managedWorktreeSchema)
      .parse((await this.store.processState.read("managed-worktrees")) ?? []);
  }
  async remember(thread: ThreadSummary) {
    if (!thread.worktree) return;
    const project = this.store.project(thread.executionProjectId ?? thread.projectId);
    const value = managedWorktreeSchema.parse({
      id: thread.id,
      projectId: thread.projectId,
      executionProjectId: project.id,
      projectPath: project.path,
      title: thread.title,
      worktree: thread.worktree,
      createdAt: thread.updatedAt,
    });
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        const records = await this.records();
        if (records.some((item) => item.id === value.id && item.projectId === value.projectId))
          return;
        await this.store.processState.write("managed-worktrees", [...records, value]);
      });
    this.writes = next;
    await next;
  }
  async forget(record: ManagedWorktree) {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        const records = await this.records();
        await this.store.processState.write(
          "managed-worktrees",
          records.filter((item) => item.id !== record.id || item.projectId !== record.projectId),
        );
      });
    this.writes = next;
    await next;
  }
}
