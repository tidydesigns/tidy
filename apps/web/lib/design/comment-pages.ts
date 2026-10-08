import type { CommentThread } from "./comments";

/** Later pages refresh metadata/reactions; overlapping detail reads never duplicate messages. */
export function mergeCommentPages(pages: readonly (readonly CommentThread[])[]): CommentThread[] {
  const threads = new Map<string, CommentThread>();
  for (const page of pages)
    for (const thread of page) {
      const previous = threads.get(thread.id);
      const messages = new Map(previous?.messages.map((message) => [message.id, message]));
      for (const message of thread.messages) messages.set(message.id, message);
      threads.set(thread.id, {
        ...thread,
        messages: [...messages.values()].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
      });
    }
  return [...threads.values()];
}
