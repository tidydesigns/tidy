import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexUsageService } from "./codex-usage";
import { PrivateState } from "../platform/private-state";
import { availableResetCredits, type ResetSelection } from "../../shared/contracts/codex-usage";
import { isRemoteMutation } from "../../shared/remote";

const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});
const accountId = "fixture-account";
const accountKey = createHash("sha256").update(accountId).digest("hex");
const now = Date.parse("2026-11-06T21:00:00Z");
function credit(id: string, hours: number | null, extra = {}) {
  return {
    id,
    status: "available",
    resetType: "codexRateLimits",
    grantedAt: now / 1000 - 1000,
    expiresAt: hours === null ? null : now / 1000 + hours * 3600,
    title: null,
    description: null,
    ...extra,
  };
}
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "tidy-reset-test-"));
  cleanups.push(path);
  const state = new PrivateState(path);
  const data = {
    now,
    supported: true,
    failRead: false,
    calls: [] as Array<Record<string, unknown>>,
    consume: async (): Promise<unknown> => ({ outcome: "reset" }),
    limits: {
      accountId: accountId as string | null,
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now / 1000 + 7200 },
      },
      rateLimitResetCredits: {
        availableCount: 3,
        credits: [credit("later", 48), credit("tonight", 2), credit("forever", null)] as
          | ReturnType<typeof credit>[]
          | null,
      },
    },
  };
  const deps = {
    now: () => data.now,
    async connect<T>(
      _cwd: string,
      use: (
        request: (method: string, params?: unknown) => Promise<unknown>,
        supported: boolean,
      ) => Promise<T>,
    ) {
      return use(async (method, params) => {
        if (method === "account/rateLimits/read") {
          if (data.failRead) throw new Error("offline");
          return structuredClone(data.limits);
        }
        expect(method).toBe("account/rateLimitResetCredit/consume");
        data.calls.push(params as Record<string, unknown>);
        return data.consume();
      }, data.supported);
    },
  };
  const service = new CodexUsageService(state, deps);
  const selection: ResetSelection = {
    accountKey,
    creditId: "tonight",
    expiresAt: credit("tonight", 2).expiresAt,
    idempotencyKey: randomUUID(),
  };
  return { data, service, state, deps, selection };
}

test("uses tonight’s exact ID, regardless of provider order, then reads authoritative usage", async () => {
  const { service, data, selection } = await fixture();
  expect(availableResetCredits(await service.read("project"), now).map((x) => x.id)).toEqual([
    "tonight",
    "later",
    "forever",
  ]);
  data.consume = async () => {
    data.limits.rateLimits.primary.usedPercent = 7;
    data.limits.rateLimitResetCredits = {
      availableCount: 2,
      credits: [credit("forever", null), credit("later", 48)],
    };
    return { outcome: "reset" };
  };
  const result = await service.consume("project", selection);
  expect(data.calls).toEqual([{ creditId: "tonight", idempotencyKey: selection.idempotencyKey }]);
  expect(result.outcome).toBe("reset");
  expect(result.usage?.windows[0].usedPercent).toBe(7);
  expect(result.usage?.resets?.availableCount).toBe(2);
});

test("never substitutes another reset if selected credit expires, disappears or changes", async () => {
  for (const change of [
    "expired",
    "removed",
    "changed-expiry",
    "redeeming",
    "unknown-type",
  ] as const) {
    const { service, data, selection } = await fixture();
    await service.read("project");
    if (change === "expired") data.now = selection.expiresAt! * 1000;
    if (change === "removed") data.limits.rateLimitResetCredits.credits!.splice(1, 1);
    if (change === "changed-expiry") data.limits.rateLimitResetCredits.credits![1].expiresAt! += 10;
    if (change === "redeeming") data.limits.rateLimitResetCredits.credits![1].status = "redeeming";
    if (change === "unknown-type")
      data.limits.rateLimitResetCredits.credits![1].resetType = "other";
    await expect(service.consume("project", selection)).rejects.toThrow();
    expect(data.calls).toHaveLength(0);
  }
});

test("unknown details, unsupported CLI and a changed/missing account fail closed", async () => {
  for (const change of ["details", "unsupported", "account", "missing-account"] as const) {
    const { service, data, selection } = await fixture();
    if (change === "details") data.limits.rateLimitResetCredits.credits = null;
    if (change === "unsupported") data.supported = false;
    if (change === "account") data.limits.accountId = "another-account";
    if (change === "missing-account") data.limits.accountId = null;
    await expect(service.consume("project", selection)).rejects.toThrow();
    expect(data.calls).toHaveLength(0);
  }
});

test("count-only and capped detail lists retain the authoritative count", async () => {
  const { service, data } = await fixture();
  data.limits.rateLimitResetCredits.availableCount = 10;
  expect((await service.read("project")).resets?.availableCount).toBe(10);
  data.limits.rateLimitResetCredits.credits = null;
  expect((await service.read("project")).resets).toEqual({ availableCount: 10, credits: null });
  data.limits.rateLimitResetCredits.credits = [];
  expect((await service.read("project")).resets).toEqual({ availableCount: 10, credits: [] });
});

test("a lost response survives restart and retries the same ID and key even after expiry", async () => {
  const { service, data, state, deps, selection } = await fixture();
  data.consume = async () => {
    data.limits.rateLimitResetCredits.credits!.splice(1, 1);
    throw new Error("response lost after redemption");
  };
  expect((await service.consume("project", selection)).outcome).toBe("unconfirmed");
  const restarted = new CodexUsageService(state, deps);
  data.now = now + 4 * 3600_000;
  expect((await restarted.read("other-project")).pendingReset).toEqual(selection);
  await expect(
    restarted.consume("other-project", {
      ...selection,
      creditId: "later",
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toThrow("previous reset");
  await expect(
    restarted.consume("other-project", { ...selection, creditId: "later" }),
  ).rejects.toThrow("original reset");
  data.consume = async () => ({ outcome: "alreadyRedeemed" });
  const result = await restarted.consume("other-project", selection);
  expect(result.outcome).toBe("alreadyRedeemed");
  expect(result.usage?.pendingReset).toBeNull();
  expect(data.calls).toEqual(
    Array(2).fill({ creditId: "tonight", idempotencyKey: selection.idempotencyKey }),
  );
});

test("double clicks and concurrent projects cannot redeem twice", async () => {
  const { service, data, selection } = await fixture();
  const outcomes = await Promise.all([
    service.consume("a", selection),
    service.consume("b", selection),
  ]);
  expect(outcomes.map((x) => x.outcome)).toEqual(["reset", "reset"]);
  expect(data.calls).toHaveLength(1);
});

test("confirmed outcomes are not converted into retries when the usage refresh fails", async () => {
  const { service, data, selection } = await fixture();
  data.consume = async () => {
    data.failRead = true;
    return { outcome: "reset" };
  };
  expect(await service.consume("project", selection)).toEqual({ outcome: "reset", usage: null });
  data.failRead = false;
  expect((await service.consume("project", selection)).outcome).toBe("reset");
  expect(data.calls).toHaveLength(1);
});

test("provider decides eligibility; every outcome preserves actual usage instead of zeroing it", async () => {
  for (const outcome of ["nothingToReset", "noCredit", "alreadyRedeemed"] as const) {
    const { service, data, selection } = await fixture();
    data.limits.rateLimits.primary.usedPercent = 80;
    data.consume = async () => ({ outcome });
    const result = await service.consume("project", selection);
    expect(result.outcome).toBe(outcome);
    expect(result.usage?.windows[0].usedPercent).toBe(80);
    expect(result.usage?.pendingReset).toBeNull();
  }
});

test("unknown outcomes remain unresolved and block a different redemption", async () => {
  const { service, data, selection } = await fixture();
  data.consume = async () => ({ outcome: "new-provider-outcome" });
  expect((await service.consume("project", selection)).outcome).toBe("unconfirmed");
  expect((await service.read("project")).pendingReset).toEqual(selection);
});

test("duplicate credit IDs are ambiguous and cannot be redeemed", async () => {
  const { service, data, selection } = await fixture();
  data.limits.rateLimitResetCredits.credits!.push(credit("tonight", 48));
  await expect(service.consume("project", selection)).rejects.toThrow("ambiguous");
  expect(data.calls).toHaveLength(0);
});

test("failed private persistence prevents spending a reset without a recoverable key", async () => {
  const { data, deps, selection } = await fixture();
  const state = {
    initialize: async () => {},
    read: async () => undefined,
    write: async () => {
      throw new Error("disk full");
    },
  };
  const service = new CodexUsageService(state as unknown as PrivateState, deps);
  await expect(service.consume("project", selection)).rejects.toThrow("disk full");
  expect(data.calls).toHaveLength(0);
});

test("redemption is a remote mutation, usage discovery is read-only", () => {
  expect(isRemoteMutation("codex-reset")).toBe(true);
  expect(isRemoteMutation("codex-usage")).toBe(false);
});

test("pending retries remain available when credit detail IDs become ambiguous", async () => {
  const { service, data, selection } = await fixture();
  data.consume = async () => {
    throw new Error("lost response");
  };
  expect((await service.consume("project", selection)).outcome).toBe("unconfirmed");
  data.limits.rateLimitResetCredits.credits!.push(credit("tonight", 48));
  const usage = await service.read("project");
  expect(usage.pendingReset).toEqual(selection);
  expect(usage.resetDetailsError).toContain("ambiguous");
  expect(usage.resets?.credits).toBeNull();
  data.consume = async () => ({ outcome: "alreadyRedeemed" });
  expect((await service.consume("project", selection)).outcome).toBe("alreadyRedeemed");
  expect(data.calls).toEqual(
    Array(2).fill({ creditId: selection.creditId, idempotencyKey: selection.idempotencyKey }),
  );
});

test("completed outcomes survive later redemptions and a host restart", async () => {
  const { service, data, state, deps, selection } = await fixture();
  expect((await service.consume("project", selection)).outcome).toBe("reset");
  data.limits.rateLimitResetCredits.credits = [credit("later", 48)];
  const second = {
    ...selection,
    creditId: "later",
    expiresAt: credit("later", 48).expiresAt,
    idempotencyKey: randomUUID(),
  };
  expect((await service.consume("project", second)).outcome).toBe("reset");
  const restarted = new CodexUsageService(state, deps);
  expect((await restarted.consume("project", selection)).outcome).toBe("reset");
  expect(data.calls).toHaveLength(2);
  await expect(restarted.consume("project", { ...selection, creditId: "later" })).rejects.toThrow(
    "original reset",
  );
});

test("a completed retry does not replace a newer pending account pointer", async () => {
  const { service, data, selection } = await fixture();
  await service.consume("project", selection);
  data.consume = async () => {
    throw new Error("lost response");
  };
  const second = {
    ...selection,
    creditId: "later",
    expiresAt: credit("later", 48).expiresAt,
    idempotencyKey: randomUUID(),
  };
  expect((await service.consume("project", second)).outcome).toBe("unconfirmed");
  expect((await service.consume("project", selection)).outcome).toBe("reset");
  expect((await service.read("project")).pendingReset).toEqual(second);
  expect(data.calls).toHaveLength(2);
});
