export function fileOpenError(cause: unknown): { message: string; retry: boolean } {
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (/outside.*project|inside this repository/i.test(text))
    return {
      message: "This file is outside this project. Open its project to view it.",
      retry: false,
    };
  if (/backend update|update.*machine|update.*backend|update.*thread/i.test(text))
    return {
      message: "Update this machine in Settings > Remote machines, then try again.",
      retry: false,
    };
  if (/different operating system|Windows/i.test(text))
    return {
      message:
        "This path belongs to another operating system. Open it on the machine that created it.",
      retry: false,
    };
  if (/permission|EACCES|EPERM|no longer have access|not authorized/i.test(text))
    return { message: "You don't have access to this file or folder.", retry: false };
  if (
    /project directory moved|project folder is missing|thread.*folder.*missing|worktree.*missing/i.test(
      text,
    )
  )
    return {
      message: "This project's folder moved or is missing. Open its current location.",
      retry: false,
    };
  if (/changed while opening/i.test(text))
    return { message: "This file changed while opening. Try again.", retry: true };
  if (/busy opening files/i.test(text))
    return { message: "This machine is busy opening files. Try again shortly.", retry: true };
  if (/offline|disconnect|reconnect/i.test(text))
    return { message: "This machine is offline. Try again when it reconnects.", retry: true };
  if (/path.*too long|no longer a folder/i.test(text))
    return { message: "This file path can't be opened.", retry: false };
  if (/timed out|too long/i.test(text))
    return { message: "This file took too long to open. Try again.", retry: true };
  if (/missing|moved or.*deleted|no longer available|ENOENT|ENOTDIR/i.test(text))
    return {
      message: "This file isn't available in this folder. It may have moved or been deleted.",
      retry: true,
    };
  if (/symbolic|shortcut|file link cannot/i.test(text))
    return { message: "This file link is missing or points outside this project.", retry: false };
  if (
    /path.*cannot|path.*can't|cannot be previewed inside this project|Choose a file reference|not supported|invalid.*path/i.test(
      text,
    )
  )
    return { message: "This file path can't be opened.", retry: false };
  return { message: "This file couldn't be opened. Try again.", retry: true };
}
