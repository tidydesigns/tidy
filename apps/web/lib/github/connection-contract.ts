import { z } from "zod";

export const installationSchema = z.object({
  id: z.number().int().positive(),
  app_id: z.number().int().positive(),
  account: z.object({ login: z.string() }),
  suspended_at: z.string().nullable(),
});
export const connectionStatusSchema = z.object({
  configured: z.boolean(),
  ready: z.boolean(),
  login: z.string().nullable(),
  connections: z.array(
    z.object({ installationId: z.string(), account: z.string(), active: z.boolean() }),
  ),
  installations: z.array(installationSchema),
  error: z.string().nullable(),
  installUrl: z.url(),
});
export type Installation = z.infer<typeof installationSchema>;
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
