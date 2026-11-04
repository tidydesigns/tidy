import { z } from "zod";

export const browserStreamingChoiceSchema = z.object({ enabled: z.boolean() }).strict();
export const browserStreamingStateSchema = browserStreamingChoiceSchema.extend({
  supported: z.boolean(),
});
export type BrowserStreamingState = z.infer<typeof browserStreamingStateSchema>;
export type BrowserStreamingAPI = {
  state(): Promise<BrowserStreamingState>;
  choose(input: z.infer<typeof browserStreamingChoiceSchema>): Promise<BrowserStreamingState>;
};
