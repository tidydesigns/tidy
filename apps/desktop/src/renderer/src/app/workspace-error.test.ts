import { expect, test } from "bun:test";
import { sessionConflictMessages } from "../../../shared/contracts/session-conflicts";
import { WorkspaceRequestError } from "../../../shared/contracts/workspace-response";
import { errorText } from "./workspace-error";

test("known session conflicts retain actionable copy after crossing the IPC boundary", () => {
  for (const message of Object.values(sessionConflictMessages))
    expect(errorText(new WorkspaceRequestError(message))).toBe(message);
});

test("session conflict feedback never exposes arbitrary native error text", () => {
  for (const message of [
    "/private/project/secret: connection failed",
    `${sessionConflictMessages.settings}\nsecret-provider-detail`,
  ])
    expect(errorText(new WorkspaceRequestError(message))).toBe(
      "The operation could not be completed. Please try again.",
    );
});
