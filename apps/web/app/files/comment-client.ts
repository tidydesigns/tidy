type CommentResult = { id?: string; error?: string };

async function mutate(fileId: string, input: Record<string, unknown>): Promise<CommentResult> {
  try {
    const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const result: CommentResult = await response.json();
    if (!response.ok) return { error: result.error || "Could not update comment. Try again." };
    return result;
  } catch {
    // Do not retry automatically: posting and reaction toggles are not idempotent.
    return { error: "Could not update comment. Check your connection and try again." };
  }
}

export function addCommentThread(
  fileId: string,
  x: number,
  y: number,
  body: string,
  pageId = "page-1",
) {
  return mutate(fileId, { action: "create", x, y, body, pageId });
}
export function addCommentReply(fileId: string, threadId: string, body: string) {
  return mutate(fileId, { action: "reply", threadId, body });
}
export function updateComment(
  fileId: string,
  messageId: string,
  previousBody: string,
  body: string,
) {
  return mutate(fileId, { action: "edit", messageId, previousBody, body });
}
export function removeCommentThread(fileId: string, threadId: string) {
  return mutate(fileId, { action: "delete", threadId });
}
export function reactToComment(fileId: string, messageId: string, emoji: string) {
  return mutate(fileId, { action: "react", messageId, emoji });
}
export function changeCommentThreadStatus(fileId: string, threadId: string, resolved: boolean) {
  return mutate(fileId, { action: "resolve", threadId, resolved });
}
