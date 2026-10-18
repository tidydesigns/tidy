import { z } from "zod";
import { COMMENT_EMOJIS } from "./comment-emoji";

export const commentEmojiSchema = z.enum(COMMENT_EMOJIS);
const id = z.string().min(1).max(120);
const body = z.string().trim().min(1).max(2000);
export const commentMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    threadId: z.uuid().optional(),
    messageId: z.uuid().optional(),
    x: z.number().int().min(-100000).max(100000),
    y: z.number().int().min(-100000).max(100000),
    body,
    pageId: id,
  }),
  z.object({ action: z.literal("reply"), threadId: id, body, messageId: z.uuid().optional() }),
  z.object({ action: z.literal("edit"), messageId: id, previousBody: z.string().max(2000), body }),
  z.object({ action: z.literal("delete"), threadId: id }),
  z.object({ action: z.literal("react"), messageId: id, emoji: commentEmojiSchema }),
  z.object({ action: z.literal("resolve"), threadId: id, resolved: z.boolean() }),
]);
export type CommentMutation = z.infer<typeof commentMutationSchema>;

const commentReactionSchema = z.object({
  emoji: z.string(),
  count: z.number().int().nonnegative(),
  reacted: z.boolean(),
});
const commentMessageSchema = z.object({
  id,
  authorId: id,
  authorName: z.string(),
  authorImage: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  reactions: z.array(commentReactionSchema),
});
export const commentCreatedSchema = z.object({ id, message: commentMessageSchema.optional() });
export const commentUpdatedSchema = z.object({ message: commentMessageSchema.optional() });
const commentThreadSchema = z.object({
  id,
  pageId: id,
  x: z.number().finite(),
  y: z.number().finite(),
  createdBy: id,
  resolved: z.boolean(),
  messages: z.array(commentMessageSchema),
  preview: commentMessageSchema
    .pick({ authorName: true, authorImage: true, body: true })
    .optional(),
});
export const commentPageSchema = z.object({
  threads: z.array(commentThreadSchema),
  viewerId: id,
  viewer: z.object({ name: z.string(), image: z.string().nullable() }).optional(),
  reactionsAvailable: z.boolean(),
  canModerateThreads: z.boolean(),
  nextCursor: z.string().nullable().optional(),
});
export type CommentReaction = z.infer<typeof commentReactionSchema>;
export type CommentMessage = z.infer<typeof commentMessageSchema>;
export type CommentThread = z.infer<typeof commentThreadSchema>;
export type CommentPage = z.infer<typeof commentPageSchema>;
