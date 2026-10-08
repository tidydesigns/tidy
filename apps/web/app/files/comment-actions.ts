"use server";
import { actionError } from "@/lib/action-error";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
  createComment,
  deleteCommentThread,
  editComment,
  replyToComment,
  setCommentThreadResolved,
  toggleCommentReaction,
} from "@/lib/design/comments";

export async function addCommentThread(
  fileId: string,
  x: number,
  y: number,
  body: string,
  pageId = "page-1",
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to comment." };
  try {
    return { id: await createComment(fileId, session.user.id, x, y, body, pageId) };
  } catch (error) {
    return { error: actionError(error, "Could not post comment.") };
  }
}

export async function addCommentReply(fileId: string, threadId: string, body: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to comment." };
  try {
    await replyToComment(fileId, threadId, session.user.id, body);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not post reply.") };
  }
}

export async function updateComment(
  fileId: string,
  messageId: string,
  previousBody: string,
  body: string,
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to edit your comment." };
  try {
    await editComment(fileId, messageId, session.user.id, previousBody, body);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not edit comment.") };
  }
}

export async function removeCommentThread(fileId: string, threadId: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to delete your thread." };
  try {
    await deleteCommentThread(fileId, threadId, session.user.id);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not delete thread.") };
  }
}

export async function reactToComment(fileId: string, messageId: string, emoji: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to react." };
  try {
    await toggleCommentReaction(fileId, messageId, session.user.id, emoji);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not update reaction.") };
  }
}

export async function changeCommentThreadStatus(
  fileId: string,
  threadId: string,
  resolved: boolean,
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to update comments." };
  try {
    await setCommentThreadResolved(fileId, threadId, session.user.id, resolved);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not update comment status.") };
  }
}
