import { z } from "zod";
import { desktopEventSchema } from "./contracts/desktop";
import type { Directory } from "./contracts/browser-directory";
import type { ProjectSnapshot } from "./contracts/desktop";

export const remoteTargetSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/,
    "Enter an SSH alias or user@hostname.",
  );
export const remoteRequestSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(80),
    input: z.unknown().optional(),
    projectPath: z.string().min(1).max(4096).startsWith("/").optional(),
    file: z.object({ name: z.string().min(1).max(200), document: z.unknown() }).optional(),
  })
  .strict();
export type RemoteRequest = z.infer<typeof remoteRequestSchema>;
export const remoteFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(3),
    hostId: z.string().uuid(),
    capabilities: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("result"), id: z.string().uuid(), response: z.unknown() }),
  z.object({ type: z.literal("event"), event: desktopEventSchema }),
]);
export const connectionStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("verification"), target: z.string(), requestId: z.string().uuid() }),
  z.object({
    kind: z.literal("preparing"),
    target: z.string(),
    phase: z.enum(["checking", "installing", "starting", "connecting", "syncing"]),
  }),
  z.object({
    kind: z.literal("authentication"),
    target: z.string(),
    promptId: z.string().uuid(),
    question: z.string(),
    secret: z.boolean(),
  }),
  z.object({ kind: z.literal("connected"), target: z.string(), warning: z.string().optional() }),
  z.object({
    kind: z.literal("reconnecting"),
    target: z.string(),
    message: z.string(),
    attempt: z.number(),
  }),
  z.object({ kind: z.literal("offline"), target: z.string(), message: z.string() }),
  z.object({
    kind: z.literal("blocked"),
    target: z.string(),
    message: z.string(),
    reason: z.enum(["authentication", "cancelled", "identity", "protocol", "setup"]),
  }),
  z.object({ kind: z.literal("closed"), target: z.string() }),
]);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export const machineSchema = z.object({
  id: z.string().uuid(),
  target: remoteTargetSchema,
  hostId: z.string().uuid().nullable(),
  lastConnectedAt: z.string().nullable(),
  restoreOnLaunch: z.boolean().optional(),
});
export type RemoteMachine = z.infer<typeof machineSchema>;
export const sshHostSchema = z.object({ alias: remoteTargetSchema });
export const sessionTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const hostDescriptorSchema = z.object({
  protocol: z.literal(3),
  hostId: z.string().uuid(),
  instanceId: z.string().uuid(),
  buildId: z.string(),
  sourceTimestamp: z.number().int().nonnegative().optional(),
  activeRuns: z.number().int().nonnegative(),
});
export const runtimeSchema = hostDescriptorSchema.omit({ activeRuns: true }).extend({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  managed: z.boolean(),
  supervisor: z.enum(["systemd", "launchd", "detached"]).optional(),
  persistenceWarning: z.string().max(1024).optional(),
});
export const preparedHostSchema = runtimeSchema.extend({
  updatePending: z.boolean().optional(),
  token: sessionTokenSchema,
  clientId: z.string().uuid(),
});
export type PreparedHost = z.infer<typeof preparedHostSchema>;
export const tailnetDiscoverySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    machines: z.array(
      z.object({ host: remoteTargetSchema, name: z.string(), online: z.boolean() }),
    ),
  }),
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
]);
export type TailnetDiscovery = z.infer<typeof tailnetDiscoverySchema>;
export type RemoteBridge = {
  connect(target: string): Promise<void>;
  machines(): Promise<RemoteMachine[]>;
  discover(): Promise<z.infer<typeof sshHostSchema>[]>;
  tailnet(): Promise<TailnetDiscovery>;
  forget(id: string): Promise<void>;
  retry(): Promise<void>;
  verify(requestId: string): Promise<void>;
  cancelVerification(requestId: string): Promise<void>;
  activity(input: { kind: "active" } | { kind: "network"; online: boolean }): Promise<void>;
  authenticate(input: { promptId: string; answer: string | null }): Promise<void>;
  status(): Promise<ConnectionStatus | null>;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
  directories(path: string): Promise<Directory>;
  openProject(path: string): Promise<ProjectSnapshot>;
};

const remoteReadOperations = new Set([
  "browser-state",
  "browser-query",
  "project-directories",
  "project-checkouts",
  "export-attachment",
  "export-design",
  "bootstrap",
  "project-snapshot",
  "harness-details",
  "harness-usage",
  "harnesses",
  "read-thread",
  "thread-ports",
  "warm-thread",
  "read-attachment",
  "read-video-chunk",
  "read-design",
  "preview-design",
  "refresh-design",
  "repository-context",
  "skills",
  "ping",
  "directories",
  "receipt",
]);
export function isRemoteMutation(name: string) {
  return !remoteReadOperations.has(name);
}
export const requestReceiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("interrupted") }),
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("complete"), response: z.unknown() }),
]);

export const machineIdSchema = z.union([z.literal("local"), z.string().uuid()]);
export const workspaceMachineSchema = z.object({
  id: machineIdSchema,
  label: z.string(),
  status: connectionStatusSchema.nullable(),
});
export type WorkspaceMachine = z.infer<typeof workspaceMachineSchema>;
export type MachineBridge = {
  list(): Promise<WorkspaceMachine[] | null>;
  onChanged(listener: () => void): () => void;
  workspace(id: string): { api: import("./contracts/desktop").DesktopAPI; remote: RemoteBridge };
};
