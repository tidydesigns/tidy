import { expect, test } from "bun:test";
import { repositoryReadError } from "./repository-errors";

test("file errors explain access failures without system details", () => {
  for (const code of ["EACCES", "EPERM"])
    expect(repositoryReadError(Object.assign(new Error("private path"), { code })).message).toBe(
      "You don't have permission to open this file or folder.",
    );
  for (const code of ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG", "ESTALE", "EIO", "UNKNOWN"])
    expect(
      repositoryReadError(Object.assign(new Error("private path"), { code })).message,
    ).not.toContain("private path");
});

test("file errors preserve deliberate project boundaries", () => {
  const boundary = new Error(
    "This file is outside this thread's project. Open its project to preview it.",
  );
  expect(repositoryReadError(boundary)).toBe(boundary);
  expect(repositoryReadError(null).message).toBe("Could not open this file. Try again.");
});
