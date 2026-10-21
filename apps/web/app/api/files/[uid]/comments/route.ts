import { reportHandledError } from "@/lib/handled-error";
import { MutationBudgetError } from "@/lib/security/mutation-budget";
import { withRequestBodyLimit } from "@/lib/http/request-body";
import { commentMutationSchema } from "@/lib/design/comment-contract";
import { auth } from "@/lib/auth";
import {
  CommentCapacityError,
  CommentCursorError,
  createCommentWithMessage,
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
    reportHandledError(error);
    if (error instanceof CommentCursorError)
      return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
  if (!comments) return new Response(null, { status: 404 });
  return Response.json(
    {
      ...comments,
      viewerId: session.user.id,
      viewer: { name: session.user.name, image: session.user.image ?? null },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

// Stable URLs keep long-lived editor tabs independent of build-specific Server Action IDs.
async function post(request: Request, { params }: RouteContext<"/api/files/[uid]/comments">) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Comment requests must come from this site." }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in to comment." }, { status: 401 });
  const input = commentMutationSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "Invalid comment request." }, { status: 400 });
  const { uid } = await params;
  const userId = session.user.id;
  const data = input.data;
  try {
    let createdId: string | undefined;
    let message: Awaited<ReturnType<typeof replyToComment>> | undefined;
    switch (data.action) {
      case "create": {
        const created = await createCommentWithMessage(
          uid,
          userId,
          data.x,
          data.y,
          data.body,
          data.pageId,
          data,
        );
        createdId = created.id;
        message = created.message;
        break;
      }
      case "reply":
        message = await replyToComment(uid, data.threadId, userId, data.body, data.messageId);
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
      default: {
        const exhaustive: never = data;
        throw new Error(`Unhandled comment action: ${exhaustive}`);
      }
    }
    return Response.json(
      {
        ...(createdId ? { id: createdId } : {}),
        ...(message
          ? {
              message: {
                ...message,
                authorName: session.user.name,
                authorImage: session.user.image ?? null,
                reactions: [],
              },
            }
          : {}),
      },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    reportHandledError(error);
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
