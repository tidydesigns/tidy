import { expect, test } from "bun:test";
import { pullRequestURL } from "../../shared/contracts/pull-request";
import { parsePullRequestState, PullRequestStates } from "./pull-request-states";

const url = "https://github.com/owner/repo/pull/42";

test("PR links canonicalize subpages and fragments without accepting other destinations", () => {
  expect(pullRequestURL(`${url}/files?diff=split#diff-123`)).toBe(url);
  expect(pullRequestURL("https://www.github.com/Owner/Repo/pull/42/commits")).toBe(url);
  for (const href of [
    "https://github.com.example.com/owner/repo/pull/42",
    "https://github.com@evil.example/owner/repo/pull/42",
    "https://user@github.com/owner/repo/pull/42",
    "http://github.com/owner/repo/pull/42",
    "https://github.com:444/owner/repo/pull/42",
    "https://gist.github.com/owner/repo/pull/42",
    "https://github.com/owner/repo/issues/42",
    "https://github.com/owner/repo/pull/42/evil",
    "https://github.com/owner/repo/pull/9007199254740992",
    "https://github.com/owner/repo/pull/0",
    `${url}\n`,
    "--help",
  ])
    expect(pullRequestURL(href)).toBeNull();
});

test("PR responses distinguish merged and closed from drafts and reject unknown states", () => {
  expect(parsePullRequestState({ state: "OPEN", isDraft: false })).toBe("open");
  expect(parsePullRequestState({ state: "OPEN", isDraft: true })).toBe("draft");
  expect(parsePullRequestState({ state: "MERGED", isDraft: false })).toBe("merged");
  expect(parsePullRequestState({ state: "CLOSED", isDraft: true })).toBe("closed");
  expect(() => parsePullRequestState({ state: "UNKNOWN", isDraft: false })).toThrow();
  expect(() => parsePullRequestState({ state: "OPEN", isDraft: "false" })).toThrow();
});

test("lookups share in-flight work, cache success, and refresh after expiry", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let time = 0;
  const states = new PullRequestStates(
    async () => {
      calls++;
      await gate;
      return calls === 1 ? "open" : "merged";
    },
    () => time,
  );
  const first = states.read(url);
  time = 120_000;
  expect(states.read(`${url}/files`)).toBe(first);
  release();
  expect(await first).toBe("open");
  expect(await states.read(url)).toBe("open");
  expect(calls).toBe(1);
  time = 180_001;
  expect(await states.read(url)).toBe("merged");
  expect(calls).toBe(2);
});

test("unavailable state stays neutral and failed reads retry after a short cache", async () => {
  let calls = 0;
  let time = 0;
  const states = new PullRequestStates(
    async () => {
      if (++calls === 1) throw new Error("Not authenticated");
      return "closed";
    },
    () => time,
  );
  expect(await states.read(url)).toBeNull();
  expect(await states.read(url)).toBeNull();
  expect(calls).toBe(1);
  time = 15_001;
  expect(await states.read(url)).toBe("closed");
  expect(await states.read("https://example.com/pull/42")).toBeNull();
  expect(calls).toBe(2);
});

test("queued requests release their slots after failures and the pending cache stays bounded", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let active = 0;
  let peak = 0;
  const states = new PullRequestStates(async (href) => {
    calls++;
    peak = Math.max(peak, ++active);
    try {
      await gate;
      if (href.endsWith("/pull/1")) throw new Error("Lookup failed");
      return "open";
    } finally {
      active--;
    }
  });
  const results = Array.from({ length: 260 }, (_, i) =>
    states.read(`https://github.com/owner/repo/pull/${i + 1}`),
  );
  expect(calls).toBe(4);
  release();
  const values = await Promise.all(results);
  expect(calls).toBe(256);
  expect(peak).toBe(4);
  expect(values.filter((value) => value === null)).toHaveLength(5);
  expect(await states.read("https://github.com/owner/repo/pull/300")).toBe("open");
  expect(calls).toBe(257);
  expect(await states.read("https://github.com/owner/repo/pull/2")).toBe("open");
  expect(calls).toBe(257);
});
