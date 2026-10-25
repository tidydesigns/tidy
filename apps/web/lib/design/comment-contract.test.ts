import { expect, test } from "bun:test";
import {
  commentPageSchema,
  commentCreatedSchema,
  commentUpdatedSchema,
  commentMutationSchema,
} from "./comment-contract";

test("comment reads preserve legacy previews, empty messages and nullable author images", () => {
  const page = {
    threads: [
      {
        id: "thread",
        pageId: "page-1",
        x: 12,
        y: 34,
        createdBy: "user",
        resolved: false,
        messages: [],
        preview: { authorName: "", authorImage: null, body: "Comment" },
      },
    ],
    viewerId: "user",
    reactionsAvailable: false,
    canModerateThreads: false,
    nextCursor: null,
  };
  expect(commentPageSchema.parse(page)).toEqual(page);
  expect(commentPageSchema.safeParse({ ...page, threads: [null] }).success).toBe(false);
  expect(commentPageSchema.safeParse(null).success).toBe(false);
});

test("comment creation requires a receipt while other writes allow the existing empty acknowledgement", () => {
  expect(commentCreatedSchema.safeParse({}).success).toBe(false);
  expect(commentCreatedSchema.parse({ id: "thread" })).toEqual({ id: "thread" });
  expect(commentUpdatedSchema.parse({})).toEqual({});
  expect(commentUpdatedSchema.safeParse(null).success).toBe(false);
  expect(
    commentMutationSchema.safeParse({ action: "react", messageId: "message", emoji: "unsupported" })
      .success,
  ).toBe(false);
});

test("posting receipts validate canonical messages and client IDs are optional UUIDs", () => {
  const message = {
    id: crypto.randomUUID(),
    authorId: "viewer",
    authorName: "Viewer",
    authorImage: null,
    body: "Sent",
    createdAt: new Date().toISOString(),
    reactions: [],
  };
  expect(commentUpdatedSchema.parse({ message })).toEqual({ message });
  expect(commentCreatedSchema.parse({ id: "thread", message })).toEqual({ id: "thread", message });
  expect(commentUpdatedSchema.safeParse({ message: { ...message, authorId: null } }).success).toBe(
    false,
  );
  expect(
    commentMutationSchema.safeParse({
      action: "reply",
      threadId: "thread",
      body: "Reply",
      messageId: "not-a-uuid",
    }).success,
  ).toBe(false);
  expect(
    commentMutationSchema.parse({
      action: "reply",
      threadId: "thread",
      body: "Reply",
      messageId: message.id,
    }),
  ).toEqual({ action: "reply", threadId: "thread", body: "Reply", messageId: message.id });
});

test("comment previews retain original timestamps and complete reply counts across message pages", () => {
  const thread = {
    id: "thread",
    pageId: "page-1",
    x: 0,
    y: 0,
    createdBy: "author",
    resolved: false,
    messages: [],
    replyCount: 120,
    preview: {
      authorName: "Author",
      authorImage: null,
      body: "Initial comment",
      createdAt: "2026-10-24T15:51:00Z",
    },
  };
  const page = {
    threads: [thread],
    viewerId: "viewer",
    reactionsAvailable: false,
    canModerateThreads: false,
  };
  expect(commentPageSchema.parse(page).threads[0]).toEqual(thread);
  expect(
    commentPageSchema.safeParse({ ...page, threads: [{ ...thread, replyCount: -1 }] }).success,
  ).toBe(false);
});
