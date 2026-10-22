import { z } from "zod";
import { attachmentSchema, MAX_ATTACHMENTS } from "./attachments";

export const MAX_QUEUED_MESSAGES = 20;
const id = z.string().uuid();
export const queuedMessageSchema = z.object({
  id,
  text: z.string().max(32_000),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

export const messageDeliverySchema = z.enum(["queue", "steer"]);
export type MessageDelivery = z.infer<typeof messageDeliverySchema>;
export const queueActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove"), messageId: id }).strict(),
  z
    .object({ kind: z.literal("edit"), messageId: id, text: z.string().trim().max(32_000) })
    .strict(),
  z.object({ kind: z.literal("move"), messageId: id, beforeId: id.nullable() }).strict(),
  z.object({ kind: z.literal("steer"), messageId: id }).strict(),
]);
export type QueueAction = z.infer<typeof queueActionSchema>;
export const queueRequestSchema = z
  .object({ projectId: id, threadId: id, action: queueActionSchema })
  .strict();
export type QueueRequest = z.infer<typeof queueRequestSchema>;

export function applyQueueAction(messages: QueuedMessage[], action: QueueAction): QueuedMessage[] {
  switch (action.kind) {
    case "remove":
    case "steer":
      return messages.filter((message) => message.id !== action.messageId);
    case "edit":
      return messages.map((message) =>
        message.id === action.messageId ? { ...message, text: action.text } : message,
      );
    case "move": {
      const message = messages.find((item) => item.id === action.messageId);
      if (!message || action.beforeId === action.messageId) return messages;
      const remaining = messages.filter((item) => item.id !== action.messageId);
      const index =
        action.beforeId === null
          ? remaining.length
          : remaining.findIndex((item) => item.id === action.beforeId);
      if (index < 0) return messages;
      return [...remaining.slice(0, index), message, ...remaining.slice(index)];
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
