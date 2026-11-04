import {
  worktreePreferencesSchema,
  type WorktreePreferences,
} from "../../shared/contracts/worktree-settings";
import type { PrivateState } from "../platform/private-state";

export class WorktreePreferencesStore {
  private writes = Promise.resolve();
  constructor(private state: PrivateState) {}
  async read(): Promise<WorktreePreferences> {
    await this.writes.catch(() => {});
    return worktreePreferencesSchema.parse((await this.state.read("worktree-preferences")) ?? {});
  }
  write(input: WorktreePreferences) {
    const preferences = worktreePreferencesSchema.parse(input);
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        await this.state.write("worktree-preferences", preferences);
      });
    this.writes = next;
    return next.then(() => preferences);
  }
}
