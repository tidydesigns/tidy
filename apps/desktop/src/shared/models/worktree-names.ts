import {
  worktreePreferencesSchema,
  type WorktreePreferences,
} from "../contracts/worktree-settings";

/** Names are fixed at creation; later conversation-title changes never rename Git refs. */
export function worktreeNames(threadId: string, input: WorktreePreferences, title: string) {
  const preferences = worktreePreferencesSchema.parse(input);
  const slug =
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "thread";
  const name = preferences.naming === "uuid" ? threadId : `${slug}-${threadId.slice(0, 8)}`;
  return { name, branch: `${preferences.branchPrefix}${name}` };
}
