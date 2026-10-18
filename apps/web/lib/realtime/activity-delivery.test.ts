import { expect, test } from "bun:test";
import type { PoolClient } from "pg";
import { inDatabaseScope } from "../database-scope";
import { publishAgentActivity } from "./server";
import type { AgentActivity } from "./agent-activity";

test("Worker presence does not block MCP; terminal delivery starts only after commit", async () => {
  const key = Symbol.for("__cloudflare-context__");
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const previous = globals[key];
  const pending: Promise<unknown>[] = [];
  const seen: AgentActivity[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  globals[key] = {
    env: {
      FILE_ROOMS: {
        getByName: () => ({
          activity: (activity: AgentActivity) => {
            seen.push(activity);
            return held;
          },
        }),
      },
    },
    ctx: { waitUntil: (task: Promise<unknown>) => pending.push(task) },
  };
  const activity: AgentActivity = {
    id: crypto.randomUUID(),
    version: 0,
    fileId: "fixture",
    actorId: "fixture",
    actorName: "Fixture",
    tool: "patch_document",
    phase: "editing",
    updatedAt: Date.now(),
    expiresAt: Date.now() + 10000,
  };
  try {
    await publishAgentActivity(activity);
    expect(seen).toHaveLength(1);
    expect(pending).toHaveLength(1);
    const scoped = await inDatabaseScope({} as PoolClient, () =>
      publishAgentActivity({ ...activity, version: 1, phase: "completed" }),
    );
    expect(seen).toHaveLength(1);
    await scoped.afterCommit();
    expect(seen.map((event) => event.phase)).toEqual(["editing", "completed"]);
    expect(pending).toHaveLength(2);
  } finally {
    release();
    await Promise.all(pending);
    if (previous === undefined) delete globals[key];
    else globals[key] = previous;
  }
});

test("committed comment relay uses Worker lifetime and does not wait for a stalled room", async () => {
  const { publishFileChangesInBackground } = await import("./server");
  const key = Symbol.for("__cloudflare-context__");
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const previous = globals[key];
  const pending: Promise<unknown>[] = [];
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  globals[key] = {
    env: {
      FILE_ROOMS: {
        getByName: () => ({
          sync: () => {
            calls++;
            return held;
          },
        }),
      },
    },
    ctx: { waitUntil: (task: Promise<unknown>) => pending.push(task) },
  };
  try {
    await publishFileChangesInBackground("fixture");
    expect(calls).toBe(1);
    expect(pending).toHaveLength(1);
    const scoped = await inDatabaseScope({} as PoolClient, () =>
      publishFileChangesInBackground("fixture"),
    );
    expect(calls).toBe(1);
    await scoped.afterCommit();
    expect(calls).toBe(2);
    expect(pending).toHaveLength(2);
  } finally {
    release();
    await Promise.all(pending);
    if (previous === undefined) delete globals[key];
    else globals[key] = previous;
  }
});
