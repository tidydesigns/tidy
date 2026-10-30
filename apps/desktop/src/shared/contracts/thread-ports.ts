import { z } from "zod";

export const threadPortSchema = z.object({
  id: z.string().uuid(),
  processId: z.string().uuid(),
  processName: z.string().max(120),
  port: z.number().int().min(1).max(65535),
  host: z.enum(["127.0.0.1", "::1"]),
});
export const threadPortsSchema = z.array(threadPortSchema).max(100);
export type ThreadPort = z.infer<typeof threadPortSchema>;

export function threadPortURL(port: Pick<ThreadPort, "host" | "port">) {
  return `http://${port.host === "::1" ? "[::1]" : "localhost"}:${port.port}`;
}
