import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mobilePairingSchema } from "@tidy/agent-protocol/mobile";
import { summarizeThread } from "@tidy/agent-protocol/models/thread-updates";
import type { Thread } from "@tidy/agent-protocol/contracts/desktop";
import { ThreadCache } from "./thread-cache";

const thread = (revision = 1): Thread => ({
  id: randomUUID(),
  projectId: randomUUID(),
  title: "Test",
  harness: "codex",
  revision,
  status: "running",
  messages: [],
  designIds: [],
  updatedAt: new Date().toISOString(),
});
test("pairing rejects cleartext, public hosts, credentials and URL tricks", () => {
  const pairing = {
    version: 1,
    hostId: randomUUID(),
    clientId: randomUUID(),
    token: "a".repeat(64),
    origin: "https://host.tailnet.ts.net",
  };
  expect(mobilePairingSchema.parse(pairing).origin).toBe(pairing.origin);
  for (const origin of [
    "http://host.tailnet.ts.net",
    "https://example.com",
    "https://host.tailnet.ts.net.evil.com",
    "https://user:secret@host.tailnet.ts.net",
    "https://host.tailnet.ts.net/path",
    "https://host.tailnet.ts.net?token=secret",
    "https://host.tailnet.ts.net#fragment",
  ])
    expect(mobilePairingSchema.safeParse({ ...pairing, origin }).success).toBe(false);
});
test("late reads cannot replace newer streamed content or project summaries", () => {
  const cache = new ThreadCache();
  const initial = thread();
  const updated = {
    ...initial,
    revision: 3,
    messages: [{ id: randomUUID(), role: "assistant" as const, text: "Latest output" }],
  };
  const snapshot = {
    project: {
      id: initial.projectId,
      path: "/project",
      name: "Project",
      openedAt: initial.updatedAt,
    },
    threads: [summarizeThread(initial)],
    designs: [],
    folders: [],
  };
  cache.putProject(snapshot);
  cache.putThread(updated);
  cache.putThread(initial);
  cache.putProject(snapshot);
  expect(cache.threads.get(initial.id)?.messages[0].text).toBe("Latest output");
  expect(cache.projects.get(initial.projectId)?.threads[0].revision).toBe(3);
});
test("patches arriving during initial thread reads are applied once the base is available", () => {
  const cache = new ThreadCache();
  const initial = thread();
  const message = { id: randomUUID(), role: "assistant" as const, text: "Streaming output" };
  const updated = { ...initial, revision: 2, messages: [message] };
  const metadata = updated;
  cache.event({
    type: "thread-patch",
    thread: metadata,
    summary: summarizeThread(updated),
    messages: [message],
    toolActivities: [],
    toolActivityIds: [],
  });
  cache.putThread(initial);
  expect(cache.threads.get(initial.id)?.messages).toEqual([message]);
  expect(cache.threads.get(initial.id)?.revision).toBe(2);
});
