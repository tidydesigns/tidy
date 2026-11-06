import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { hostDescriptorSchema, type PreparedHost } from "../../shared/remote";
import { RemoteFailure } from "./errors";
import { shellQuote, type SshSession } from "./ssh";

export async function openTunnel({
  ssh,
  host,
  signal,
}: {
  ssh: SshSession;
  host: PreparedHost;
  signal: AbortSignal;
}) {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port.");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  signal.throwIfAborted();
  const readyMarker = `TIDY_FORWARD_${randomBytes(16).toString("hex")}`;
  const child = ssh.launch({
    args: ["-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${port}:127.0.0.1:${host.port}`],
    command: [`/bin/sh -c ${shellQuote(`printf '%s\\n' '${readyMarker}'; cat >/dev/null`)}`],
  });
  let ready = false;
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = output + chunk.toString();
    if (text.includes(`${readyMarker}\n`)) ready = true;
    output = text.slice(-readyMarker.length);
  });
  let failure: string | undefined;
  let diagnostics = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4096);
  });
  child.on("error", (error) => {
    failure = error.message;
  });
  child.on("close", () => {
    failure = diagnostics.trim() || "SSH tunnel closed.";
  });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  child.once("close", () => signal.removeEventListener("abort", abort));
  try {
    const deadline = Date.now() + 330_000;
    let attempts = 0;
    while (Date.now() < deadline && (ssh.awaitingVerification || attempts < 150)) {
      if (!ssh.awaitingVerification) attempts++;
      signal.throwIfAborted();
      if (failure) throw ssh.failure(failure);
      if (!ready) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
          redirect: "error",
        });
        const descriptor = hostDescriptorSchema.parse(await response.json());
        signal.throwIfAborted();
        if (failure) throw ssh.failure(failure);
        if (descriptor.hostId !== host.hostId || descriptor.instanceId !== host.instanceId)
          throw new RemoteFailure("identity", "Remote backend identity mismatch.");
        return {
          origin: `http://127.0.0.1:${port}`,
          close: () => {
            child.kill();
          },
          onClose: (listener: () => void) => {
            child.once("close", listener);
            if (failure) listener();
          },
        };
      } catch (error) {
        signal.throwIfAborted();
        if (failure) throw ssh.failure(failure);
        if (error instanceof RemoteFailure) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("The SSH tunnel did not become ready.");
  } catch (error) {
    child.kill();
    throw error;
  }
}
