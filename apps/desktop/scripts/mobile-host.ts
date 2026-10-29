import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { mobileOriginSchema } from "@tidy/agent-protocol/mobile";
import { workspaceHostDirectory, workspaceRuntime } from "../src/main/remote/workspace-host";
import { SessionStore } from "../src/main/remote/session-store";
import { createMobileGateway } from "../src/main/remote/mobile-gateway";

// This command never changes Tailscale configuration or starts agent work.
const directory = workspaceHostDirectory();
const sessions = new SessionStore(join(directory, "sessions"));
const [command, argument] = process.argv.slice(2);
if (command === "revoke") {
  await sessions.revoke(z.string().uuid().parse(argument));
  console.log("Phone access revoked.");
} else if (command === "serve" || command === "pair") {
  const origin = mobileOriginSchema.parse(argument);
  const runtime = await workspaceRuntime(directory);
  if (!runtime)
    throw new Error("Open Tidy desktop on this machine first, or start the existing tidy-host.");
  if (command === "pair") {
    const clientId = randomUUID();
    const token = await sessions.issue(clientId);
    console.log(JSON.stringify({ version: 1, origin, hostId: runtime.hostId, clientId, token }));
    console.error(
      "Paste this private pairing code into Tidy on your phone. It grants access to this host. Do not share it.",
    );
  } else {
    const gateway = createMobileGateway(origin, async () => {
      const current = await workspaceRuntime(directory);
      if (!current || current.hostId !== runtime.hostId) throw new Error("Host unavailable.");
      return current.port;
    });
    const port = await gateway.listen();
    console.log(`Mobile gateway listening on 127.0.0.1:${port}.`);
    console.log(
      `Configure Tailscale Serve separately: tailscale serve --bg --https=${new URL(origin).port || "443"} http://127.0.0.1:${port}`,
    );
    const close = () => {
      void gateway.close().then(() => process.exit(0));
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  }
} else {
  console.error(
    "Usage: bun mobile:host serve HTTPS_TAILNET_ORIGIN | pair HTTPS_TAILNET_ORIGIN | revoke CLIENT_ID",
  );
  process.exitCode = 1;
}
