import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mobileCommandSchema, mobileInputSchema, mobileStateRequestSchema } from "./mobile";
import { isRemoteMutation } from "../remote";

test("device requests reject arbitrary commands, paths and non-finite input coordinates", () => {
  const scope = { projectId: randomUUID(), sessionId: randomUUID() };
  expect(
    mobileCommandSchema.safeParse({
      ...scope,
      kind: "run",
      targetId: "xcode:app",
      command: "arbitrary shell",
    }).success,
  ).toBe(false);
  expect(mobileCommandSchema.safeParse({ ...scope, kind: "erase" }).success).toBe(false);
  for (const x of [NaN, Infinity, -1, 1.01])
    expect(
      mobileInputSchema.safeParse({ ...scope, event: { kind: "touch", phase: "down", x, y: 0 } })
        .success,
    ).toBe(false);
  expect(
    mobileInputSchema.safeParse({ ...scope, event: { kind: "text", text: "x".repeat(4097) } })
      .success,
  ).toBe(false);
});

test("build commands use receipts while ephemeral touches and frames are never replayed", () => {
  expect(isRemoteMutation("mobile-command")).toBe(true);
  expect(isRemoteMutation("mobile-input")).toBe(false);
  expect(isRemoteMutation("mobile-frame")).toBe(false);
  expect(isRemoteMutation("mobile-state")).toBe(false);
});

test("mobile build scopes accept thread identities while rejecting client-selected directories", () => {
  const scope = { projectId: randomUUID(), threadId: randomUUID(), threadProjectId: randomUUID() };
  expect(mobileStateRequestSchema.safeParse(scope).success).toBe(true);
  expect(
    mobileCommandSchema.safeParse({
      ...scope,
      kind: "run",
      sessionId: randomUUID(),
      targetId: "expo:.",
    }).success,
  ).toBe(true);
  expect(
    mobileStateRequestSchema.safeParse({ ...scope, threadId: "../../elsewhere" }).success,
  ).toBe(false);
  expect(mobileStateRequestSchema.safeParse({ ...scope, directory: "/elsewhere" }).success).toBe(
    false,
  );
});
