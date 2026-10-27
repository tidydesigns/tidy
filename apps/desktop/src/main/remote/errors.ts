import { ZodError } from "zod";
export type RemoteFailureKind =
  | "unavailable"
  | "authentication"
  | "cancelled"
  | "identity"
  | "protocol"
  | "setup";
export class RemoteFailure extends Error {
  constructor(
    readonly kind: RemoteFailureKind,
    message: string,
  ) {
    super(message);
  }
}
export function remoteFailure(error: unknown): RemoteFailure {
  if (error instanceof ZodError || error instanceof SyntaxError)
    return new RemoteFailure(
      "protocol",
      "The backend returned an incompatible response. Check the installed version before retrying.",
    );
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return new RemoteFailure(
      "setup",
      "A required local program or backend bundle is missing. Check the desktop installation and OpenSSH.",
    );
  return error instanceof RemoteFailure
    ? error
    : new RemoteFailure(
        "unavailable",
        error instanceof Error ? error.message : "The remote machine is unavailable.",
      );
}
export function sshFailure(message: string): RemoteFailure {
  if (/REMOTE HOST IDENTIFICATION|host key verification failed/i.test(message))
    return new RemoteFailure(
      "identity",
      "The SSH host key changed or could not be verified. Verify the machine before reconnecting.",
    );
  if (/permission denied|authentication failed|too many authentication failures/i.test(message))
    return new RemoteFailure(
      "authentication",
      "SSH authentication failed. Retry to enter fresh credentials.",
    );
  if (
    /checksum|unsupported|automatic setup currently supports|install curl|no space left|disk quota|another installation|backend did not become ready|manual restart/i.test(
      message,
    )
  )
    return new RemoteFailure("setup", message);
  return new RemoteFailure(
    "unavailable",
    message || "SSH connection failed. Check the destination and network.",
  );
}
