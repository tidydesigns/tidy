import type { Thread } from "../../../../shared/contracts/desktop";

export function retainConversations({
  recent,
  selected,
  threads,
}: {
  recent: (string | null)[];
  selected: string | null;
  threads: Record<string, Thread>;
}): (string | null)[] {
  const retained: (string | null)[] = [];
  let messages = 0;
  let characters = 0;
  for (const id of [selected, ...recent]) {
    if (retained.includes(id)) continue;
    const thread = id ? threads[id] : undefined;
    if (id !== selected && !thread) continue;
    const count = thread?.messages.length ?? 0;
    const size = thread?.messages.reduce((total, message) => total + message.text.length, 0) ?? 0;
    if (retained.length && (messages + count > 1000 || characters + size > 2_000_000)) continue;
    retained.push(id);
    messages += count;
    characters += size;
    if (retained.length === 3) break;
  }
  return retained;
}
