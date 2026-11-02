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
  message = message.replace(/TIDY_PHASE:[^\s\\]+(?:\\n)?/g, "").trim();
  if (/Backend identity changed/i.test(message))
    return new RemoteFailure(
      "identity",
      "Backend identity changed. Verify this machine before reconnecting.",
    );
  if (/backend protocol is incompatible/i.test(message))
    return new RemoteFailure(
      "protocol",
      "This desktop and the remote backend use incompatible protocols. Install compatible versions before reconnecting.",
    );
  if (/cannot create temp file for here-document/i.test(message))
    return new RemoteFailure(
      "setup",
      "The remote shell could not write temporary files. Free temporary storage on the remote machine, then retry. The backend installer uses your home directory.",
    );
  if (/no space left|disk quota|EDQUOT|ENOSPC/i.test(message))
    return new RemoteFailure(
      "setup",
      "The remote machine's disk or user storage quota is full. Free space in your remote home directory, then retry. Existing work was left in place.",
    );
  if (
    /EACCES|EROFS|read-only file system|(?:mkdir|chmod|cannot create|cannot open).*permission denied/i.test(
      message,
    )
  )
    return new RemoteFailure(
      "setup",
      "Tidy cannot write to its storage on the remote machine. Restore write access to its runtime and state directories, then retry.",
    );
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
  if (/ETIMEDOUT|another installation is still running/i.test(message))
    return new RemoteFailure(
      "unavailable",
      "Remote setup is still busy. Retrying the connection shortly.",
    );
  if (
    /checksum|unsupported|automatic setup (?:currently )?supports|separate installer|install curl|no space left|disk quota|another installation|backend did not become ready|manual restart|recovery failed|installation failed|installation is damaged|runtime is damaged|runtime directory/i.test(
      message,
    )
  )
    return new RemoteFailure("setup", message);
  return new RemoteFailure(
    "unavailable",
    message || "SSH connection failed. Check the destination and network.",
  );
}
