import { z } from "zod";

export const communityStarStatusSchema = z.enum(["starred", "unstarred", "unavailable"]);

export type CommunityAPI = {
  status(): Promise<z.infer<typeof communityStarStatusSchema>>;
  star(): Promise<boolean>;
  open(): Promise<void>;
};
