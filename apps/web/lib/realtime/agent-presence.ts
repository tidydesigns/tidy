import {
  activityTerminal,
  activityVisible,
  activityWorking,
  type AgentActivity,
} from "./agent-activity";

export function presenceDeadline(activity: AgentActivity) {
  return Math.min(
    activity.expiresAt,
    activityTerminal(activity) ? activity.updatedAt + 6000 : Infinity,
  );
}

/** One teammate per client. Collapse import calls before choosing a focus so an
 * old staged/receiving event cannot outlive that import's latest outcome. */
export function agentPresences(activities: AgentActivity[], now: number) {
  const operations = new Map<string, AgentActivity>();
  for (const activity of [...activities].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.version - a.version,
  )) {
    if (activity.threadId) continue;
    const key = `${activity.actorId}:${activity.importId ?? activity.id}`;
    if (!operations.has(key)) operations.set(key, activity);
  }
  const priority = (activity: AgentActivity) =>
    activityWorking(activity)
      ? activity.phase === "reading"
        ? 2
        : 4
      : activity.phase === "staged"
        ? 3
        : 1;
  const actors = new Map<string, AgentActivity>();
  for (const activity of [...operations.values()]
    .filter((item) => activityVisible(item, now))
    .sort(
      (a, b) => priority(b) - priority(a) || b.updatedAt - a.updatedAt || b.version - a.version,
    )) {
    if (!actors.has(activity.actorId)) actors.set(activity.actorId, activity);
  }
  return [...actors.values()];
}

/** A client keeps its accent across calls and reconnects. */
export function presenceColor(actorId: string) {
  let hash = 0;
  for (const character of actorId) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return ["blue", "violet", "teal"][Math.abs(hash) % 3];
}
