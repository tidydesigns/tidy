import { ZodError } from "zod";

const phaseMarkerPattern = /TIDY_PHASE:[^\s\\]+(?:\\n)?/g;
const identityChangedPattern = /Backend identity changed/i;
const incompatibleProtocolPattern = /backend protocol is incompatible/i;
const temporaryFileFailurePattern = /cannot create temp file for here-document/i;
const diskFullPattern = /no space left|disk quota|EDQUOT|ENOSPC/i;
const writeDeniedPattern =
  /EACCES|EROFS|read-only file system|(?:mkdir|chmod|cannot create|cannot open).*permission denied/i;
const hostIdentityPattern = /REMOTE HOST IDENTIFICATION|host key verification failed/i;
const authenticationFailurePattern =
  /permission denied|authentication failed|too many authentication failures/i;
const installationBusyPattern = /ETIMEDOUT|another installation is still running/i;
const setupFailurePattern =
  /checksum|unsupported|automatic setup (?:currently )?supports|separate installer|install curl|no space left|disk quota|another installation|backend did not become ready|manual restart|recovery failed|installation failed|installation is damaged|runtime is damaged|runtime directory/i;

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
  message = message.replace(phaseMarkerPattern, "").trim();
  if (identityChangedPattern.test(message))
    return new RemoteFailure(
      "identity",
      "Backend identity changed. Verify this machine before reconnecting.",
    );
  if (incompatibleProtocolPattern.test(message))
    return new RemoteFailure(
      "protocol",
      "This desktop and the remote backend use incompatible protocols. Install compatible versions before reconnecting.",
    );
  if (temporaryFileFailurePattern.test(message))
    return new RemoteFailure(
      "setup",
      "The remote shell could not write temporary files. Free temporary storage on the remote machine, then retry. The backend installer uses your home directory.",
    );
  if (diskFullPattern.test(message))
    return new RemoteFailure(
      "setup",
      "The remote machine's disk or user storage quota is full. Free space in your remote home directory, then retry. Existing work was left in place.",
    );
  if (writeDeniedPattern.test(message))
    return new RemoteFailure(
      "setup",
      "Tidy cannot write to its storage on the remote machine. Restore write access to its runtime and state directories, then retry.",
    );
  if (hostIdentityPattern.test(message))
    return new RemoteFailure(
      "identity",
      "The SSH host key changed or could not be verified. Verify the machine before reconnecting.",
    );
  if (authenticationFailurePattern.test(message))
    return new RemoteFailure(
      "authentication",
      "SSH authentication failed. Retry to enter fresh credentials.",
    );
  if (installationBusyPattern.test(message))
    return new RemoteFailure(
      "unavailable",
      "Remote setup is still busy. Retrying the connection shortly.",
    );
  if (setupFailurePattern.test(message)) return new RemoteFailure("setup", message);
  return new RemoteFailure(
    "unavailable",
    message || "SSH connection failed. Check the destination and network.",
  );
}
