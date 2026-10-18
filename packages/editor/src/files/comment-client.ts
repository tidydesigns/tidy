import {
  commentCreatedSchema,
  commentUpdatedSchema,
  type CommentMutation,
  type CommentMessage,
} from "../design/comment-contract";
import { readJsonResponse } from "../lib/http/json-response";

type CommentResult =
  | { kind: "created"; id: string; message?: CommentMessage }
  | { kind: "updated"; message?: CommentMessage }
  | { kind: "error"; error: string };
async function mutate({
  fileId,
  input,
}: {
  fileId: string;
  input: CommentMutation;
}): Promise<CommentResult> {
  try {
    const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const message = "Could not update comment. Check your connection and try again.";
    if (input.action === "create") {
      const result = await readJsonResponse({ response, schema: commentCreatedSchema, message });
      return { kind: "created", id: result.id, message: result.message };
    }
    const result = await readJsonResponse({ response, schema: commentUpdatedSchema, message });
    return { kind: "updated", message: result.message };
  } catch (error) {
    // Keep retries intentional: legacy posts and reaction toggles are not idempotent.
    return {
      kind: "error",
      error: error instanceof Error ? error.message : "Could not update comment. Try again.",
    };
  }
}
type Input<Action extends CommentMutation["action"]> = { fileId: string } & Omit<
  Extract<CommentMutation, { action: Action }>,
  "action"
>;
export function addCommentThread({ fileId, ...input }: Input<"create">) {
  return mutate({ fileId, input: { action: "create", ...input } });
}
export function addCommentReply({ fileId, ...input }: Input<"reply">) {
  return mutate({ fileId, input: { action: "reply", ...input } });
}
export function updateComment({ fileId, ...input }: Input<"edit">) {
  return mutate({ fileId, input: { action: "edit", ...input } });
}
export function removeCommentThread({ fileId, ...input }: Input<"delete">) {
  return mutate({ fileId, input: { action: "delete", ...input } });
}
export function reactToComment({ fileId, ...input }: Input<"react">) {
  return mutate({ fileId, input: { action: "react", ...input } });
}
export function changeCommentThreadStatus({ fileId, ...input }: Input<"resolve">) {
  return mutate({ fileId, input: { action: "resolve", ...input } });
}
