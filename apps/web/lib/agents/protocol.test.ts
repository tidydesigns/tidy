import { expect, test } from "bun:test";
import {
  connectionStatusSchema,
  nativeLoginSchema,
  threadListSchema,
  threadSnapshotSchema,
  threadEventsSchema,
  startedRunSchema,
  steeredRunSchema,
  type ThreadSnapshot,
  type NativeLogin,
} from "./protocol";
import { readJsonResponse } from "../http/json-response";

const snapshot = {
  thread: {
    id: "thread",
    organizationId: "org",
    title: "Design",
    updatedAt: "2026-10-16 12:00:00+00",
    sequence: 0,
    files: [],
    run: null,
    activeAgents: 0,
  },
  messages: [],
  workers: [],
  hasOlder: false,
} satisfies ThreadSnapshot;

test("thread boundaries accept empty history and PostgreSQL timestamps without inventing data", () => {
  expect(threadSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(threadListSchema.parse({ threads: [snapshot.thread] }).threads).toHaveLength(1);
  expect(
    threadEventsSchema.parse({
      events: [{ type: "new.event", sequence: 1, payload: { future: true } }],
    }).events[0].payload,
  ).toEqual({ future: true });
});

test("thread boundaries reject malformed nested values and preserve public errors", async () => {
  for (const value of [
    null,
    {},
    { ...snapshot, thread: null },
    { ...snapshot, messages: [null] },
    { ...snapshot, workers: [{}] },
    { ...snapshot, thread: { ...snapshot.thread, sequence: "0" } },
  ]) {
    await expect(
      readJsonResponse({
        response: Response.json(value),
        schema: threadSnapshotSchema,
        message: "Could not load thread.",
      }),
    ).rejects.toThrow("Could not load thread.");
  }
  await expect(
    readJsonResponse({
      response: Response.json({ error: "Access ended." }, { status: 403 }),
      schema: threadSnapshotSchema,
      message: "Could not load thread.",
    }),
  ).rejects.toThrow("Access ended.");
  expect(startedRunSchema.safeParse({ messageId: "message" }).success).toBe(false);
  expect(steeredRunSchema.parse({ messageId: "message" }).messageId).toBe("message");
});

test("connection and login responses cannot populate settings with partial data", () => {
  expect(
    connectionStatusSchema.parse({
      configured: false,
      planSharingConfigured: false,
      provider: "codex",
      status: "disconnected",
      accountLabel: null,
      usageUrl: "https://chatgpt.com/codex/settings/usage",
      helpUrl: "https://help.openai.com/",
    }).accountLabel,
  ).toBeNull();
  expect(connectionStatusSchema.safeParse({ status: "connected" }).success).toBe(false);
  const login = {
    type: "chatgptDeviceCode",
    loginId: "login",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  } satisfies NativeLogin;
  expect(nativeLoginSchema.parse(login)).toEqual(login);
  expect(
    nativeLoginSchema.safeParse({ ...login, verificationUrl: "https://other.example.test" })
      .success,
  ).toBe(false);
});
