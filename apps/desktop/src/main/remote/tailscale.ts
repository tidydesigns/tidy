import { execFile } from "node:child_process";
import { z } from "zod";
import { remoteTargetSchema, type TailnetDiscovery } from "../../shared/remote";

const statusSchema = z.object({
  BackendState: z.string(),
  Peer: z
    .record(
      z.string(),
      z.object({
        HostName: z.string(),
        DNSName: z.string(),
        OS: z.string(),
        Online: z.boolean(),
      }),
    )
    .nullish(),
});
export function parseTailnetStatus(input: unknown): TailnetDiscovery {
  const status = statusSchema.parse(input);
  if (status.BackendState !== "Running")
    return {
      kind: "unavailable",
      message: "Open Tailscale and connect this machine to your tailnet.",
    };
  const machines = Object.values(status.Peer ?? {})
    .filter((peer) => ["linux", "macos", "darwin"].includes(peer.OS.toLowerCase()))
    .flatMap((peer) => {
      const host = remoteTargetSchema.safeParse(peer.DNSName.replace(/\.$/, "") || peer.HostName);
      return host.success ? [{ host: host.data, name: peer.HostName, online: peer.Online }] : [];
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    .slice(0, 100);
  return { kind: "ready", machines };
}
export async function discoverTailnet(): Promise<TailnetDiscovery> {
  const paths =
    process.platform === "darwin"
      ? ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
      : ["tailscale"];
  for (const path of paths) {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          path,
          ["status", "--json"],
          {
            timeout: 2500,
            killSignal: "SIGKILL",
            maxBuffer: 2 * 1024 * 1024,
            encoding: "utf8",
            windowsHide: true,
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
      return parseTailnetStatus(JSON.parse(stdout));
    } catch {}
  }
  return {
    kind: "unavailable",
    message: "Tailscale discovery isn’t available. You can still enter your SSH destination.",
  };
}
