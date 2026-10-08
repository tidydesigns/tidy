import { PublicActionError } from "@/lib/security/public-error";
import { reserveCommentMutation } from "@/lib/security/mutation-budget";
import { publishFileChanges } from "@/lib/realtime/server";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { PoolClient } from "pg";
import { COMMENT_LIMITS } from "@/lib/security/resource-limits";
import { can, EDIT_ROLES_SQL, VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { COMMENT_EMOJIS } from "@/lib/design/comment-emoji";
import { documentPages } from "@/lib/design/pages";
import type { DesignDocument } from "@/lib/design/document";

export type CommentReaction = { emoji: string; count: number; reacted: boolean };
export type CommentMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorImage: string | null;
  body: string;
  createdAt: string;
  reactions: CommentReaction[];
};
export type CommentThread = {
  id: string;
  pageId: string;
  x: number;
  y: number;
  createdBy: string;
  resolved: boolean;
  messages: CommentMessage[];
  preview?: Pick<CommentMessage, "authorName" | "authorImage" | "body">;
};

function cleanBody(body: string) {
  const value = body.trim();
  if (!value || value.length > 2000)
    throw new PublicActionError("Comments must be between 1 and 2000 characters.");
  return value;
}

const commentAccessQuery = `select m."role", f."organizationId" from "designFile" f
  join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL}
  join "user" u on u."id"=m."userId" and u."emailVerified"=true
  where f."id"=$1 and f."archivedAt" is null`;

/** File-first locks serialize capacity checks and keep membership live through each operation. */
async function withCommentFile<T>(
  fileId: string,
  userId: string,
  write: boolean,
  operation: (client: PoolClient, role: string) => Promise<T>,
): Promise<T | null> {
  if (write) {
    const access = await db.query<{ organizationId: string }>(commentAccessQuery, [fileId, userId]);
    if (!access.rows[0]) throw new PublicActionError("File not found or access denied.");
    await reserveCommentMutation(userId, access.rows[0].organizationId);
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    const access = await client.query<{ role: string }>(
      `${commentAccessQuery}
      ${write ? "for update of f for share of m, u" : "for share of f, m, u"}`,
      [fileId, userId],
    );
    if (!access.rows[0]) {
      if (write) throw new PublicActionError("File not found or access denied.");
      await client.query("commit");
      return null;
    }
    const result = await operation(client, access.rows[0].role);
    await client.query("commit");
    if (write) await publishFileChanges(fileId);
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export class CommentCapacityError extends PublicActionError {}
async function admitComment(client: PoolClient, fileId: string, threadId?: string) {
  const counts = await client.query<{ threads: number; messages: number; replies: number }>(
    `select
    (select count(*)::int from "designCommentThread" where "fileId"=$1) as threads,
    (select count(*)::int from "designCommentMessage" c join "designCommentThread" t on t."id"=c."threadId" where t."fileId"=$1) as messages,
    (select count(*)::int from "designCommentMessage" c join "designCommentThread" t on t."id"=c."threadId" where t."fileId"=$1 and t."id"=$2) as replies`,
    [fileId, threadId ?? null],
  );
  const usage = counts.rows[0];
  if (
    (!threadId && usage.threads >= COMMENT_LIMITS.threadsPerFile) ||
    usage.messages >= COMMENT_LIMITS.messagesPerFile ||
    usage.replies >= COMMENT_LIMITS.messagesPerThread
  ) {
    throw new CommentCapacityError(
      "This file or thread has reached its comment limit. Remove an old thread before adding more comments.",
    );
  }
}

export type CommentPage = {
  threads: CommentThread[];
  reactionsAvailable: boolean;
  canModerateThreads: boolean;
  nextCursor: string | null;
};
export class CommentCursorError extends PublicActionError {}
const COMMENT_PAGE_SIZE = 100;
function readCommentCursor(cursor?: string) {
  if (!cursor) return null;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at) ||
      !Number.isFinite(Date.parse(value.at)) ||
      Number(value.at.slice(0, 4)) < 1 ||
      new Date(value.at).toISOString().slice(0, 19) !== value.at.slice(0, 19) ||
      typeof value.id !== "string" ||
      !value.id.length ||
      value.id.length > 120
    )
      throw new Error();
    return { at: value.at as string, id: value.id as string };
  } catch {
    throw new CommentCursorError("Invalid comment cursor.");
  }
}

/** A page contains at most 100 messages and only their parent threads/reaction summaries. */
export async function listComments(
  fileId: string,
  userId: string,
  options: { cursor?: string; threadId?: string; pageId?: string } = {},
): Promise<CommentPage | null> {
  const cursor = readCommentCursor(options.cursor);
  if (options.threadId !== undefined && (!options.threadId.length || options.threadId.length > 120))
    throw new CommentCursorError("Invalid thread.");
  if (options.pageId !== undefined && (!options.pageId.length || options.pageId.length > 120))
    throw new CommentCursorError("Invalid page.");
  return withCommentFile(fileId, userId, false, async (client, role) => {
    const reactionSchema = await client.query<{ available: boolean }>(
      `select to_regclass('public."designCommentReaction"') is not null as available`,
    );
    const reactionsAvailable = reactionSchema.rows[0]?.available ?? false;
    // Detail reads start at the newest messages so a just-posted reply is visible.
    const backwards = options.threadId !== undefined;
    const result = await client.query<{
      id: string;
      threadId: string;
      authorId: string;
      authorName: string;
      authorImage: string | null;
      body: string;
      createdAt: string;
      pageId: string;
      x: number;
      y: number;
      createdBy: string;
      resolved: boolean;
      preview: NonNullable<CommentThread["preview"]>;
    }>(
      `
      select c."id", c."threadId", c."authorId", u."name" as "authorName", u."image" as "authorImage", c."body",
        to_char(c."createdAt" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
        t."x", t."y", t."createdBy", t."resolved", jsonb_build_object('authorName', preview.name, 'authorImage', preview.image, 'body', preview.body) as preview, coalesce(d."content"->'commentPages'->>t."id", 'page-1') as "pageId"
      from "designCommentMessage" c join "designCommentThread" t on t."id"=c."threadId"
      join "user" u on u."id"=c."authorId" left join "designDocument" d on d."fileId"=t."fileId"
      join lateral (select first."body" as body, author."name" as name, author."image" as image
        from "designCommentMessage" first join "user" author on author."id"=first."authorId"
        where first."threadId"=t."id" order by first."createdAt", first."id" limit 1) preview on true
      where t."fileId"=$1 and ($2::text is null or t."id"=$2)
        and ($6::text is null or coalesce(d."content"->'commentPages'->>t."id", 'page-1')=$6)
        and ($3::timestamptz is null or (c."createdAt", c."id") ${backwards ? "<" : ">"} ($3::timestamptz,$4::text))
      order by c."createdAt" ${backwards ? "desc" : "asc"}, c."id" ${backwards ? "desc" : "asc"} limit $5`,
      [
        fileId,
        options.threadId ?? null,
        cursor?.at ?? null,
        cursor?.id ?? null,
        COMMENT_PAGE_SIZE + 1,
        options.pageId ?? null,
      ],
    );
    const rows = result.rows.slice(0, COMMENT_PAGE_SIZE);
    const last = rows.at(-1);
    const nextCursor =
      result.rows.length > COMMENT_PAGE_SIZE && last
        ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString("base64url")
        : null;
    const reactions =
      reactionsAvailable && rows.length
        ? await client.query<{ messageId: string; emoji: string; count: number; reacted: boolean }>(
            `
      select "messageId", "emoji", count(*)::int as count, bool_or("userId"=$2) as reacted
      from "designCommentReaction" where "messageId"=any($1::text[]) group by "messageId", "emoji"`,
            [rows.map((row) => row.id), userId],
          )
        : { rows: [] };
    const byMessage = new Map<string, CommentReaction[]>();
    for (const { messageId, emoji, count, reacted } of reactions.rows) {
      const bucket = byMessage.get(messageId) ?? [];
      bucket.push({ emoji, count, reacted });
      byMessage.set(messageId, bucket);
    }
    const threads = new Map<string, CommentThread>();
    for (const row of backwards ? rows.reverse() : rows) {
      const thread = threads.get(row.threadId) ?? {
        id: row.threadId,
        pageId: row.pageId,
        x: row.x,
        y: row.y,
        createdBy: row.createdBy,
        resolved: row.resolved,
        preview: row.preview,
        messages: [],
      };
      thread.messages.push({
        id: row.id,
        authorId: row.authorId,
        authorName: row.authorName,
        authorImage: row.authorImage,
        body: row.body,
        createdAt: row.createdAt,
        reactions: (byMessage.get(row.id) ?? []).sort(
          (a, b) =>
            COMMENT_EMOJIS.indexOf(a.emoji as (typeof COMMENT_EMOJIS)[number]) -
            COMMENT_EMOJIS.indexOf(b.emoji as (typeof COMMENT_EMOJIS)[number]),
        ),
      });
      threads.set(thread.id, thread);
    }
    return {
      threads: [...threads.values()],
      reactionsAvailable,
      canModerateThreads: can(role, "edit"),
      nextCursor,
    };
  });
}

export async function createComment(
  fileId: string,
  userId: string,
  x: number,
  y: number,
  body: string,
  pageId = "page-1",
) {
  if (
    !Number.isInteger(x) ||
    x < -100000 ||
    x > 100000 ||
    !Number.isInteger(y) ||
    y < -100000 ||
    y > 100000
  )
    throw new PublicActionError("Invalid comment position.");
  const text = cleanBody(body);
  return (await withCommentFile(fileId, userId, true, async (client) => {
    await admitComment(client, fileId);
    const document = await client.query<{ content: DesignDocument }>(
      `select "content" from "designDocument" where "fileId" = $1 for update`,
      [fileId],
    );
    if (
      !document.rows[0] ||
      !documentPages(document.rows[0].content).some((page) => page.id === pageId)
    )
      throw new PublicActionError("Page not found.");
    const threadId = randomUUID();
    await client.query(
      `insert into "designCommentThread" ("id", "fileId", "x", "y", "createdBy") values ($1,$2,$3,$4,$5)`,
      [threadId, fileId, x, y, userId],
    );
    await client.query(
      `insert into "designCommentMessage" ("id", "threadId", "authorId", "body") values ($1,$2,$3,$4)`,
      [randomUUID(), threadId, userId, text],
    );
    const commentPages = { ...document.rows[0].content.commentPages, [threadId]: pageId };
    await client.query(
      `update "designDocument" set "content" = jsonb_set("content", '{commentPages}', $2::jsonb) where "fileId" = $1`,
      [fileId, JSON.stringify(commentPages)],
    );
    return threadId;
  }))!;
}

export async function replyToComment(
  fileId: string,
  threadId: string,
  userId: string,
  body: string,
) {
  const text = cleanBody(body);
  await withCommentFile(fileId, userId, true, async (client) => {
    await admitComment(client, fileId, threadId);
    const result = await client.query(
      `insert into "designCommentMessage" ("id", "threadId", "authorId", "body")
      select $1, t."id", $2, $3 from "designCommentThread" t join "designFile" f on f."id" = t."fileId"
      join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2
      where t."id" = $4 and t."fileId" = $5 returning "id"`,
      [randomUUID(), userId, text, threadId, fileId],
    );
    if (!result.rowCount) throw new PublicActionError("Comment thread not found.");
  });
}

export async function editComment(
  fileId: string,
  messageId: string,
  userId: string,
  previousBody: string,
  body: string,
) {
  const text = cleanBody(body);
  await withCommentFile(fileId, userId, true, async (client) => {
    const result = await client.query(
      `update "designCommentMessage" c set "body" = $4
      from "designCommentThread" t join "designFile" f on f."id" = t."fileId"
      join "member" m on m."organizationId" = f."organizationId" and m."userId" = $3
      where c."id" = $2 and c."threadId" = t."id" and t."fileId" = $1
        and c."authorId" = $3 and c."body" = $5 returning c."id"`,
      [fileId, messageId, userId, text, previousBody],
    );
    if (!result.rowCount)
      throw new PublicActionError("Could not edit this comment. It may have changed elsewhere.");
  });
}

export async function deleteCommentThread(fileId: string, threadId: string, userId: string) {
  await withCommentFile(fileId, userId, true, async (client) => {
    const result = await client.query(
      `delete from "designCommentThread" t
      using "designFile" f, "member" m
      where t."id" = $2 and t."fileId" = $1 and (t."createdBy" = $3 or m."role" in ${EDIT_ROLES_SQL})
        and f."id" = t."fileId" and m."organizationId" = f."organizationId" and m."userId" = $3
      returning t."id"`,
      [fileId, threadId, userId],
    );
    if (!result.rowCount)
      throw new PublicActionError(
        "Could not delete this thread. Only its author or a file editor can remove it.",
      );
    // The thread's page map is part of the document and must not accumulate after deletion.
    await client.query(
      `update "designDocument" set "content"=jsonb_set("content", '{commentPages}', coalesce("content"->'commentPages','{}'::jsonb)-$2::text) where "fileId"=$1`,
      [fileId, threadId],
    );
  });
}

export async function setCommentThreadResolved(
  fileId: string,
  threadId: string,
  userId: string,
  resolved: boolean,
) {
  if (typeof resolved !== "boolean") throw new PublicActionError("Choose a valid comment status.");
  await withCommentFile(fileId, userId, true, async (client) => {
    const result = await client.query(
      `update "designCommentThread" t set "resolved" = $4
      from "designFile" f, "member" m
      where t."id" = $2 and t."fileId" = $1
        and f."id" = t."fileId" and m."organizationId" = f."organizationId" and m."userId" = $3
        and (t."createdBy" = $3 or m."role" in ${EDIT_ROLES_SQL})
      returning t."id"`,
      [fileId, threadId, userId, resolved],
    );
    if (!result.rowCount)
      throw new PublicActionError(
        "Could not update this thread. Only its author or a file editor can resolve or reopen it.",
      );
  });
}

export async function toggleCommentReaction(
  fileId: string,
  messageId: string,
  userId: string,
  emoji: string,
) {
  if (!(COMMENT_EMOJIS as readonly string[]).includes(emoji))
    throw new PublicActionError("Choose an available emoji.");
  await withCommentFile(fileId, userId, true, async (client) => {
    const access = await client.query(
      `select c."id" from "designCommentMessage" c
      join "designCommentThread" t on t."id" = c."threadId"
      join "designFile" f on f."id" = t."fileId"
      join "member" m on m."organizationId" = f."organizationId" and m."userId" = $3
      where c."id" = $2 and t."fileId" = $1 for update of c`,
      [fileId, messageId, userId],
    );
    if (!access.rowCount) throw new PublicActionError("Comment not found.");
    const removed = await client.query(
      `delete from "designCommentReaction" where "messageId" = $1 and "userId" = $2 and "emoji" = $3 returning "emoji"`,
      [messageId, userId, emoji],
    );
    if (!removed.rowCount) {
      const usage = (
        await client.query<{ message: number; file: number }>(
          `select
        (select count(*)::int from (select 1 from "designCommentReaction" where "messageId"=$2 limit $3) limited) as message,
        (select count(*)::int from (select 1 from "designCommentReaction" r
          join "designCommentMessage" c on c."id"=r."messageId"
          join "designCommentThread" t on t."id"=c."threadId" where t."fileId"=$1 limit $4) limited) as file`,
          [fileId, messageId, COMMENT_LIMITS.reactionsPerMessage, COMMENT_LIMITS.reactionsPerFile],
        )
      ).rows[0];
      if (
        usage.message >= COMMENT_LIMITS.reactionsPerMessage ||
        usage.file >= COMMENT_LIMITS.reactionsPerFile
      ) {
        throw new CommentCapacityError(
          "This comment or file has reached its reaction limit. Existing reactions can still be removed.",
        );
      }
      await client.query(
        `insert into "designCommentReaction" ("messageId", "userId", "emoji") values ($1,$2,$3)`,
        [messageId, userId, emoji],
      );
    }
  });
}
