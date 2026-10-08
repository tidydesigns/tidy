import { MutationBudgetError } from "@/lib/security/mutation-budget";
import { withRequestBodyLimit } from "@/lib/http/request-body";
import { z } from "zod";
import { COMMENT_EMOJIS } from "@/lib/design/comment-emoji";
import { auth } from "@/lib/auth";
import {
  CommentCapacityError,
  CommentCursorError,
  createComment,
  deleteCommentThread,
  editComment,
  replyToComment,
  setCommentThreadResolved,
  toggleCommentReaction,
  listComments,
} from "@/lib/design/comments";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: RouteContext<"/api/files/[uid]/comments">) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const { uid } = await params;
  const url = new URL(request.url);
  let comments;
  try {
    comments = await listComments(uid, session.user.id, {
      cursor: url.searchParams.get("cursor") ?? undefined,
      threadId: url.searchParams.get("threadId") ?? undefined,
      pageId: url.searchParams.get("pageId") ?? undefined,
    });
  } catch (error) {
    if (error instanceof CommentCursorError)
      return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
  if (!comments) return new Response(null, { status: 404 });
  return Response.json(
    { ...comments, viewerId: session.user.id },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

// Stable URLs keep long-lived editor tabs independent of build-specific Server Action IDs.
const id = z.string().min(1).max(120);
const body = z.string().trim().min(1).max(2000);
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    x: z.number().int().min(-100000).max(100000),
    y: z.number().int().min(-100000).max(100000),
    body,
    pageId: id,
  }),
  z.object({ action: z.literal("reply"), threadId: id, body }),
  z.object({ action: z.literal("edit"), messageId: id, previousBody: z.string().max(2000), body }),
  z.object({ action: z.literal("delete"), threadId: id }),
  z.object({ action: z.literal("react"), messageId: id, emoji: z.enum(COMMENT_EMOJIS) }),
  z.object({ action: z.literal("resolve"), threadId: id, resolved: z.boolean() }),
]);

async function post(request: Request, { params }: RouteContext<"/api/files/[uid]/comments">) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Comment requests must come from this site." }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in to comment." }, { status: 401 });
  const input = mutationSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "Invalid comment request." }, { status: 400 });
  const { uid } = await params;
  const userId = session.user.id;
  const data = input.data;
  try {
    let createdId: string | undefined;
    switch (data.action) {
      case "create":
        createdId = await createComment(uid, userId, data.x, data.y, data.body, data.pageId);
        break;
      case "reply":
        await replyToComment(uid, data.threadId, userId, data.body);
        break;
      case "edit":
        await editComment(uid, data.messageId, userId, data.previousBody, data.body);
        break;
      case "delete":
        await deleteCommentThread(uid, data.threadId, userId);
        break;
      case "react":
        await toggleCommentReaction(uid, data.messageId, userId, data.emoji);
        break;
      case "resolve":
        await setCommentThreadResolved(uid, data.threadId, userId, data.resolved);
        break;
    }
    return Response.json(createdId ? { id: createdId } : {}, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof MutationBudgetError)
      return Response.json(
        { error: error.message },
        {
          status: 429,
          headers: {
            "Retry-After": String(error.retryAfter),
            "Cache-Control": "private, no-store",
          },
        },
      );
    if (error instanceof CommentCapacityError)
      return Response.json(
        { error: error.message },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    return Response.json(
      { error: "Could not update this comment. Check your access and try again." },
      { status: 409 },
    );
  }
}

export const POST = withRequestBodyLimit(post);
