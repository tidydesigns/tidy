import { z } from "zod";
import type { AgentActivity } from "./agent-activity";

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
export type Actor = { userId: string; name: string; image: string | null };
export type Peer = Actor & Presence & { sessionId: string; color: string; updatedAt: number };
export type FileEvent = { sequence: number; kind: "document" | "metadata" | "comments" };
export type RoomMessage =
  | { type: "activity"; activity: AgentActivity }
  | { type: "activities"; activities: AgentActivity[] }
  | { type: "access"; canEdit: boolean }
  | { type: "peers"; peers: Peer[] }
  | { type: "presence"; peer: Peer }
  | { type: "leave"; sessionId: string }
  | { type: "events"; events: FileEvent[] }
  | { type: "ready" }
  | { type: "pong" };
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
