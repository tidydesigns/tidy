import { z } from "zod";
import {
  projectSchema,
  threadSummarySchema,
  liveThreadSchema,
  harnessConnectionSchema,
  designSchema,
  folderSchema,
} from "./contracts/desktop";
import { directorySchema } from "./contracts/browser-directory";
import { harnessDetailsSchema } from "./contracts/harness-settings";
import { sessionTokenSchema } from "./remote";

// A phone only sends credentials to a private, TLS-protected tailnet endpoint.
export const mobileOriginSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(url.hostname)
      ) {
        throw new Error();
      }
      return url.origin;
    } catch {
      context.addIssue({
        code: "custom",
        message: "Use your Tailscale HTTPS address, such as https://computer.tailnet.ts.net.",
      });
      return z.NEVER;
    }
  });
export const mobilePairingSchema = z
  .object({
    version: z.literal(1),
    origin: mobileOriginSchema,
    hostId: z.string().uuid(),
    clientId: z.string().uuid(),
    token: sessionTokenSchema,
  })
  .strict();
export type MobilePairing = z.infer<typeof mobilePairingSchema>;

const snapshot = z.object({
  project: projectSchema,
  threads: z.array(threadSummarySchema),
  designs: z.array(designSchema),
  folders: z.array(folderSchema),
});
export const mobileResponses = {
  bootstrap: z.object({
    projects: z.array(projectSchema),
    activeProject: snapshot.nullable(),
    harnesses: z.array(harnessConnectionSchema),
  }),
  "select-project": snapshot,
  "project-snapshot": snapshot,
  "open-project": snapshot.nullable(),
  "project-directories": directorySchema,
  "harness-details": harnessDetailsSchema,
  "read-thread": liveThreadSchema,
  "start-thread": liveThreadSchema,
  "send-message": liveThreadSchema,
  "respond-approval": liveThreadSchema,
  "thread-settings": liveThreadSchema,
  "message-queue": liveThreadSchema,
  "stop-thread": z.unknown(),
  ping: z.null(),
};
export type MobileOperation = keyof typeof mobileResponses;
export type MobileResponse<N extends MobileOperation> = z.infer<(typeof mobileResponses)[N]>;
export function parseMobileResponse<N extends MobileOperation>(
  name: N,
  value: unknown,
): MobileResponse<N> {
  const envelope = z
    .discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), data: z.unknown().optional() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
    .parse(value);
  if (!envelope.ok) throw new Error(envelope.error);
  return mobileResponses[name].parse(envelope.data) as MobileResponse<N>;
}
