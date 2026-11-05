import type { Thread } from "../../../../shared/contracts/desktop";

export function groupMessageActivity(
  thread: Pick<Thread, "messages" | "toolActivities">,
  previous?: ReadonlyMap<string, NonNullable<Thread["toolActivities"]>>,
) {
  const messages = new Set(thread.messages.map((message) => message.id));
  const groups = new Map<string, NonNullable<Thread["toolActivities"]>>();
  for (const tool of thread.toolActivities ?? []) {
    if (!messages.has(tool.afterMessageId)) continue;
    const group = groups.get(tool.afterMessageId) ?? [];
    group.push(tool);
    groups.set(tool.afterMessageId, group);
  }
  for (const [id, group] of groups) {
    const retained = previous?.get(id);
    if (retained?.length === group.length && group.every((tool, index) => tool === retained[index]))
      groups.set(id, retained);
  }
  return groups;
}

export function groupConversationTurns(messages: Thread["messages"]) {
  const turns: Thread["messages"][] = [];
  let group: Thread["messages"] = [];
  let timed = false;
  for (const message of messages) {
    if (message.role === "user" && (message.turn || !timed)) {
      if (group.length) turns.push(group);
      group = [];
      timed = Boolean(message.turn);
    }
    group.push(message);
  }
  if (group.length) turns.push(group);
  return turns;
}

export function streamingAssistantMessage({
  messages,
  turnId,
}: {
  messages: Thread["messages"];
  turnId?: string;
}) {
  let assistant: string | undefined;
  let inTurn = false;
  for (const message of messages) {
    if (message.id === turnId) inTurn = true;
    if (inTurn && message.role === "assistant") assistant = message.id;
  }
  return assistant;
}

export function splitTurnResponse(messages: Thread["messages"]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const response = messages[index];
    if (response.role === "assistant")
      return {
        history: messages.slice(0, index),
        response,
        trailing: messages.slice(index + 1),
      };
  }
  return { history: messages, response: undefined, trailing: [] };
}
