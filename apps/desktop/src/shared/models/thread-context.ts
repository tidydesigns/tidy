import type { Thread } from "../contracts/desktop";

/** Bound cold-session context without copying tool output or the full transcript. */
export function threadHistoryContext(messages: Thread["messages"]) {
  const recent: Array<{ role: string; text: string }> = [];
  let remaining = 32_000;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const message = messages[index];
    const text = message.text.slice(-remaining);
    recent.push({ role: message.role, text });
    remaining -= text.length + 64;
  }
  return [
    "This is a new native session continuing an existing Tidy conversation. Recent conversation follows as historical context. The working directory and permissions supplied for this turn take precedence over any earlier directory or mode. Earlier messages may be omitted or shortened.",
    JSON.stringify(recent.reverse()),
  ].join("\n\n");
}
