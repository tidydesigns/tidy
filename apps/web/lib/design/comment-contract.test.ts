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
