import { z } from "zod";

export const appUpdateStateSchema = z.object({
  status: z.enum([
    "unsupported",
    "idle",
    "checking",
    "downloading",
    "ready",
    "installing",
    "error",
  ]),
  version: z.string().optional(),
});
export type AppUpdateState = z.infer<typeof appUpdateStateSchema>;
