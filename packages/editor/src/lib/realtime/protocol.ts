import { z } from "zod";
import { agentActivitySchema } from "./agent-activity";

const id = z.string().min(1).max(120);
const point = z
  .object({
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000),
  })
  .strict();
export const presenceSchema = z
  .object({
    pageId: id,
    cursor: point.nullable(),
    selectedIds: z.array(id).max(100),
    action: z
      .enum([
        "select",
        "hand",
        "frame",
        "rectangle",
        "pen",
        "text",
        "comment",
        "move",
        "resize",
        "typing",
      ])
      .nullable(),
    away: z.boolean(),
    preview: z
      .object({
        nodeId: id.optional(),
        box: z
          .object({
            x: z.number().finite(),
            y: z.number().finite(),
            width: z.number().finite().min(1).max(5000),
            height: z.number().finite().min(1).max(5000),
          })
          .strict()
          .optional(),
        text: z.string().max(10000).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type Presence = z.infer<typeof presenceSchema>;
export const actorSchema = z.object({
  userId: id,
  name: z.string().max(200),
  image: z.string().max(2048).nullable(),
});
export const peerSchema = presenceSchema
  .extend({
    ...actorSchema.shape,
    sessionId: z.uuid(),
    color: z.string(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strip();
export const fileEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  kind: z.enum(["document", "metadata", "comments"]),
});
export const roomMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("activity"), activity: agentActivitySchema }),
  z.object({ type: z.literal("activities"), activities: z.array(agentActivitySchema) }),
  z.object({ type: z.literal("access"), canEdit: z.boolean() }),
  z.object({ type: z.literal("peers"), peers: z.array(peerSchema) }),
  z.object({ type: z.literal("presence"), peer: peerSchema }),
  z.object({ type: z.literal("leave"), sessionId: z.uuid() }),
  z.object({ type: z.literal("events"), events: z.array(fileEventSchema) }),
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("pong") }),
]);
export type Actor = z.infer<typeof actorSchema>;
export type Peer = z.infer<typeof peerSchema>;
export type FileEvent = z.infer<typeof fileEventSchema>;
export type RoomMessage = z.infer<typeof roomMessageSchema>;

export function readRoomMessage(input: unknown): RoomMessage | null {
  if (typeof input !== "string") return null;
  try {
    const value: unknown = JSON.parse(input);
    const parsed = roomMessageSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export const EMPTY_PRESENCE: Presence = {
  pageId: "page-1",
  cursor: null,
  selectedIds: [],
  action: null,
  away: false,
  preview: null,
};
const colors = ["#4477dd", "#d65c97", "#279981", "#aa7436", "#8661d1", "#c85e48"];
export function actorColor(userId: string) {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}
