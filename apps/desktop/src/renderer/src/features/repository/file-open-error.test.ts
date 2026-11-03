import { expect, test } from "bun:test";
import { fileOpenError } from "./file-open-error";

test("temporary failures explain what to do and allow another attempt", () => {
  expect(
    fileOpenError(new Error("Remote machine is disconnected. Wait for reconnection.")),
  ).toEqual({ message: "This machine is offline. Try again when it reconnects.", retry: true });
  expect(fileOpenError(new Error("Request timed out."))).toEqual({
    message: "This file took too long to open. Try again.",
    retry: true,
  });
  expect(
    fileOpenError(new Error("This machine is busy opening files. Try again shortly.")),
  ).toEqual({
    message: "This machine is busy opening files. Try again shortly.",
    retry: true,
  });
  expect(fileOpenError(new Error("ENOENT: open /private/project/file.ts"))).toEqual({
    message: "This file isn't available in this folder. It may have moved or been deleted.",
    retry: true,
  });
});
test("repeating permanent failures is not offered as a fix", () => {
  for (const message of [
    "Choose a path inside this repository.",
    "Repository files need a backend update.",
    "This file belongs to a different operating system.",
    "EACCES: /private/project/file.ts",
    "Symbolic link target cannot be opened.",
  ])
    expect(fileOpenError(new Error(message)).retry).toBe(false);
});
test("unexpected system details stay out of visible copy", () => {
  expect(fileOpenError(new Error("EIO: read /private/project/secrets.txt"))).toEqual({
    message: "This file couldn't be opened. Try again.",
    retry: true,
  });
});
