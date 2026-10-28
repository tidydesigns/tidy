import type { Thread } from "../../../../shared/contracts/desktop";

export function groupTurnActivity(thread: Pick<Thread, "messages" | "toolActivities">) {
  const owners = new Map<string, string>();
  let owner: string | undefined;
  let timed = false;
  for (const message of thread.messages) {
    if (message.role === "user" && (message.turn || !timed)) {
      owner = message.id;
      timed = Boolean(message.turn);
    }
    if (owner) owners.set(message.id, owner);
  }
  const groups = new Map<string, NonNullable<Thread["toolActivities"]>>();
  for (const tool of thread.toolActivities ?? []) {
    const id = owners.get(tool.afterMessageId);
    if (!id) continue;
    const group = groups.get(id) ?? [];
    group.push(tool);
    groups.set(id, group);
  }
  return groups;
}
