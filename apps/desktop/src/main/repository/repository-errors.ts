export function repositoryReadError(cause: unknown): Error {
  if (!(cause instanceof Error)) return new Error("Could not open this file. Try again.");
  if (!("code" in cause)) return cause;
  switch (cause.code) {
    case "ENOENT":
      return new Error("This file or folder is missing. It may have moved or been deleted.");
    case "EACCES":
    case "EPERM":
      return new Error("You don't have permission to open this file or folder.");
    case "ENOTDIR":
      return new Error("Part of this file path is no longer a folder.");
    case "ELOOP":
      return new Error("This file link cannot be opened.");
    case "ENAMETOOLONG":
      return new Error("This file path is too long to open.");
    case "ESTALE":
    case "EBUSY":
    case "EIO":
      return new Error("Could not read this file. Try again.");
    default:
      return new Error("Could not open this file. Try again.");
  }
}
