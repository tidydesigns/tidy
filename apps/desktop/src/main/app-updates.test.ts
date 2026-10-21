import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { AppUpdates, compareAppVersions, selectAppUpdate } from "./app-updates";
import type { AppUpdateState } from "../shared/app-updates";

function release(version = "0.1.0-beta.12", arch = "arm64") {
  const tag_name = `desktop-v${version}`;
  return {
    tag_name,
    draft: false,
    prerelease: version.includes("-beta."),
    assets: [`desktop-update-${arch}.json`, `Tidy-${version}-mac-${arch}.zip`].map((name) => ({
      name,
      size: 100,
      browser_download_url: `https://github.com/tidydesigns/tidy/releases/download/${tag_name}/${name}`,
    })),
  };
}

test("version comparison handles numeric betas, stable promotion and base versions", () => {
  for (const [newer, older] of [
    ["0.1.0-beta.12", "0.1.0-beta.9"],
    ["0.1.0", "0.1.0-beta.12"],
    ["0.2.0-beta.1", "0.1.0"],
    ["1.0.0", "0.99.99"],
  ]) {
    expect(compareAppVersions(newer, older)).toBeGreaterThan(0);
    expect(compareAppVersions(older, newer)).toBeLessThan(0);
    expect(compareAppVersions(newer, newer)).toBe(0);
  }
  expect(() => compareAppVersions("0.1.0-rc.1", "0.1.0")).toThrow();
});

test("discovery chooses the highest compatible version regardless of publication order", () => {
  expect(
    selectAppUpdate([release("0.1.0-beta.12"), release("0.1.0-beta.9")], "0.1.0-beta.8", "arm64")
      ?.version,
  ).toBe("0.1.0-beta.12");
  expect(
    selectAppUpdate([release("0.1.0"), release("0.2.0-beta.1")], "0.1.0-beta.8", "arm64")?.version,
  ).toBe("0.2.0-beta.1");
  expect(selectAppUpdate([release("0.1.0"), release("0.2.0-beta.1")], "0.1.0", "arm64")).toBeNull();
  expect(selectAppUpdate([release("0.1.0")], "0.1.0-beta.8", "arm64")?.version).toBe("0.1.0");
  expect(selectAppUpdate([release()], "0.1.0-beta.12", "arm64")).toBeNull();
  expect(selectAppUpdate([release()], "0.1.0-beta.13", "arm64")).toBeNull();
});

test("drafts, unrelated tags, wrong architectures, incomplete assets and foreign URLs are ignored", () => {
  for (const change of ["draft", "tag", "arch", "zip", "feed", "url", "channel", "empty"]) {
    const value = release();
    if (change === "draft") value.draft = true;
    if (change === "tag") value.tag_name = "v0.1.0-beta.12";
    if (change === "arch") value.assets = release(undefined, "x64").assets;
    if (change === "zip") value.assets.pop();
    if (change === "feed") value.assets.shift();
    if (change === "url")
      value.assets[0].browser_download_url = "https://example.invalid/update.json";
    if (change === "channel") value.prerelease = false;
    if (change === "empty") value.assets[1].size = 0;
    expect(selectAppUpdate([value], "0.1.0-beta.1", "arm64")).toBeNull();
  }
});

function fixture(overrides: Partial<ConstructorParameters<typeof AppUpdates>[0]> = {}) {
  const native = Object.assign(new EventEmitter(), {
    feeds: [] as string[],
    checks: 0,
    installs: 0,
    setFeedURL({ url }: { url: string }) {
      this.feeds.push(url);
    },
    checkForUpdates() {
      this.checks++;
    },
    quitAndInstall() {
      this.installs++;
    },
  });
  let fetches = 0;
  const updater = new AppUpdates({
    supported: true,
    version: "0.1.0-beta.1",
    arch: "arm64",
    native,
    fetch: async () => {
      fetches++;
      return new Response(JSON.stringify([release()]));
    },
    prepareInstall: async () => {},
    ...overrides,
  });
  return { updater, native, fetches: () => fetches };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("background checks stage once, publish readiness and flush writes before installing", async () => {
  let finish!: () => void;
  const { updater, native, fetches } = fixture({
    prepareInstall: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  const states: AppUpdateState["status"][] = [];
  updater.subscribe((state) => states.push(state.status));
  updater.start();
  try {
    await tick();
    expect(native.feeds[0]).toBe(
      "https://github.com/tidydesigns/tidy/releases/download/desktop-v0.1.0-beta.12/desktop-update-arm64.json",
    );
    expect(updater.state.status).toBe("downloading");
    await updater.check();
    expect(fetches()).toBe(1);
    await expect(updater.install()).rejects.toThrow("No desktop update is ready");
    native.emit("update-downloaded");
    await updater.check();
    expect(fetches()).toBe(1);
    const install = updater.install();
    expect(updater.state.status).toBe("installing");
    expect(native.installs).toBe(0);
    await expect(updater.install()).rejects.toThrow();
    finish();
    await install;
    expect(native.installs).toBe(1);
    expect(states).toEqual(["checking", "downloading", "ready", "installing"]);
  } finally {
    updater.stop();
  }
});

test("network and native failures retry without publishing sensitive diagnostics", async () => {
  let online = false;
  const { updater, native } = fixture({
    fetch: async () => {
      if (!online) throw new Error("private/path secret");
      return new Response(JSON.stringify([release()]));
    },
  });
  updater.start();
  try {
    await tick();
    expect(updater.state).toEqual({ status: "error", error: "check", version: undefined });
    online = true;
    await updater.check();
    expect(updater.state.status).toBe("downloading");
    native.emit("error", new Error("private signing diagnostic"));
    expect(updater.state).toEqual({ status: "error", error: "download", version: "0.1.0-beta.12" });
    await updater.check();
    native.emit("update-downloaded");
    expect(updater.state.status).toBe("ready");
  } finally {
    updater.stop();
  }
});

test("empty native feeds return to polling and malformed discovery never starts a download", async () => {
  let malformed = false;
  const { updater, native } = fixture({
    fetch: async () =>
      new Response(JSON.stringify(malformed ? { unexpected: "payload" } : [release()])),
  });
  updater.start();
  try {
    await tick();
    native.emit("update-not-available");
    expect(updater.state.status).toBe("idle");
    malformed = true;
    await updater.check();
    expect(updater.state).toEqual({ status: "error", error: "check", version: undefined });
    expect(native.checks).toBe(1);
    malformed = false;
    await updater.check();
    expect(native.checks).toBe(2);
  } finally {
    updater.stop();
  }
});

test("discovery scans later pages for a higher beta and stays on the original channel", async () => {
  const urls: string[] = [];
  const { updater, native } = fixture({
    fetch: async (url) => {
      urls.push(url);
      const releases = url.endsWith("page=1")
        ? [release("0.1.0"), ...Array.from({ length: 99 }, () => release("0.1.0-beta.1"))]
        : [release("0.2.0-beta.1")];
      return new Response(JSON.stringify(releases));
    },
  });
  updater.start();
  try {
    await tick();
    expect(urls.length).toBe(2);
    expect(updater.state).toEqual({ status: "downloading", version: "0.2.0-beta.1" });
    expect(native.checks).toBe(1);
  } finally {
    updater.stop();
  }
});

test("conditional discovery reuses each page on 304 and detects changed releases", async () => {
  let round = 0;
  const requests: (string | null)[] = [];
  const { updater, native } = fixture({
    fetch: async (url, init) => {
      const page = url.endsWith("page=1") ? 1 : 2;
      requests.push(new Headers(init.headers).get("if-none-match"));
      if (round === 1 || (round === 2 && page === 1)) return new Response(null, { status: 304 });
      const releases =
        page === 1
          ? Array.from({ length: 100 }, () => release("0.1.0-beta.1"))
          : [release(round === 2 ? "0.2.0-beta.1" : "0.1.0-beta.12")];
      return new Response(JSON.stringify(releases), { headers: { etag: `"page-${page}"` } });
    },
  });
  updater.start();
  try {
    await tick();
    expect(updater.state.version).toBe("0.1.0-beta.12");
    native.emit("update-not-available");
    round = 1;
    await updater.check();
    expect(updater.state.version).toBe("0.1.0-beta.12");
    native.emit("update-not-available");
    round = 2;
    await updater.check();
    expect(updater.state.version).toBe("0.2.0-beta.1");
    expect(requests).toEqual([null, null, '"page-1"', '"page-2"', '"page-1"', '"page-2"']);
  } finally {
    updater.stop();
  }
});

test("a replacement response without an ETag clears the old conditional cache", async () => {
  const requests: (string | null)[] = [];
  const { updater, native } = fixture({
    fetch: async (_url, init) => {
      requests.push(new Headers(init.headers).get("if-none-match"));
      return new Response(JSON.stringify([release()]), {
        headers: requests.length === 1 ? { etag: '"first"' } : {},
      });
    },
  });
  updater.start();
  try {
    await tick();
    native.emit("update-not-available");
    await updater.check();
    native.emit("update-not-available");
    await updater.check();
    expect(requests).toEqual([null, '"first"', null]);
  } finally {
    updater.stop();
  }
});

test("rate limits stay quiet, honor both retry deadlines and block manual retry storms", async () => {
  const initial = 1_800_000_000_000;
  const delay = 2 * 60 * 60 * 1000;
  const deadline = initial + delay + 60_000;
  const headers: Record<string, string>[] = [
    { "retry-after": String((delay + 60_000) / 1000) },
    { "retry-after": new Date(deadline).toUTCString() },
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(deadline / 1000) },
    {
      "retry-after": String(delay / 1000),
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(deadline / 1000),
    },
    {
      "retry-after": String((delay + 60_000) / 1000),
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String((initial + delay) / 1000),
    },
  ];
  for (const status of [403, 429]) {
    for (const retryHeaders of headers) {
      let now = initial;
      let calls = 0;
      const { updater, native } = fixture({
        now: () => now,
        fetch: async () => {
          calls++;
          if (calls > 1) return new Response(JSON.stringify([release()]));
          return new Response(null, {
            status,
            headers: retryHeaders,
          });
        },
      });
      updater.start();
      try {
        await tick();
        expect(updater.state).toEqual({ status: "idle" });
        now += delay;
        await updater.check();
        await updater.check();
        expect(calls).toBe(1);
        now += 60_000;
        await updater.check();
        expect(calls).toBe(2);
        expect(native.checks).toBe(1);
      } finally {
        updater.stop();
      }
    }
  }
});

test("missing or malformed rate-limit headers use increasing backoff and recover", async () => {
  const halfHour = 30 * 60 * 1000;
  let now = 1_800_000_000_000;
  let calls = 0;
  const { updater, native } = fixture({
    now: () => now,
    fetch: async () => {
      calls++;
      return calls < 3 || calls === 4
        ? new Response(null, {
            status: 429,
            headers:
              calls === 1
                ? {}
                : {
                    "retry-after": "invalid",
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset": "invalid",
                  },
          })
        : new Response(JSON.stringify([release()]));
    },
  });
  updater.start();
  try {
    await tick();
    await updater.check();
    expect(calls).toBe(1);
    now += halfHour;
    await updater.check();
    expect(calls).toBe(2);
    now += halfHour;
    await updater.check();
    expect(calls).toBe(2);
    now += halfHour;
    await updater.check();
    expect(calls).toBe(3);
    expect(updater.state.status).toBe("downloading");
    native.emit("update-not-available");
    await updater.check();
    expect(calls).toBe(4);
    now += halfHour;
    await updater.check();
    expect(calls).toBe(5);
    expect(native.checks).toBe(2);
  } finally {
    updater.stop();
  }
});

test("failed preparation preserves the update for another install attempt", async () => {
  const { updater, native } = fixture({
    prepareInstall: async () => {
      throw new Error("disk failure");
    },
  });
  updater.start();
  try {
    await tick();
    native.emit("update-downloaded");
    await expect(updater.install()).rejects.toThrow("Please try again");
    expect(updater.state.status).toBe("ready");
    expect(native.installs).toBe(0);
  } finally {
    updater.stop();
  }
});

test("asynchronous native restart failures restore the workspace and keep the staged update", async () => {
  let restored = 0;
  const { updater, native } = fixture({
    prepareInstall: async () => () => {
      restored++;
    },
  });
  updater.start();
  try {
    await tick();
    native.emit("update-downloaded");
    await updater.install();
    expect(updater.state.status).toBe("installing");
    native.emit("error", new Error("private path /Volumes/readonly"));
    expect(restored).toBe(1);
    expect(updater.state).toEqual({ status: "ready", version: "0.1.0-beta.12", error: "install" });
    await updater.install();
    expect(native.installs).toBe(2);
  } finally {
    updater.stop();
  }
});

test("synchronous native restart errors cannot leave the app stuck installing", async () => {
  let restored = 0;
  const { updater, native } = fixture({
    prepareInstall: async () => () => {
      restored++;
    },
  });
  native.quitAndInstall = () => {
    native.emit("error", new Error("restart failed"));
  };
  updater.start();
  try {
    await tick();
    native.emit("update-downloaded");
    await expect(updater.install()).rejects.toThrow("Please try again");
    expect(restored).toBe(1);
    expect(updater.state.status).toBe("ready");
  } finally {
    updater.stop();
  }
});

test("quitting while update preparation is pending never calls the native installer", async () => {
  let prepared!: () => void;
  let restored = 0;
  const { updater, native } = fixture({
    prepareInstall: () =>
      new Promise((resolve) => {
        prepared = () =>
          resolve(() => {
            restored++;
          });
      }),
  });
  updater.start();
  await tick();
  native.emit("update-downloaded");
  const installation = updater.install().then(
    () => null,
    (error: unknown) => error,
  );
  updater.stop();
  prepared();
  expect(String(await installation)).toContain("Please try again");
  expect(native.installs).toBe(0);
  expect(restored).toBe(1);
});

test("development and unsupported packages never check or install", async () => {
  const { updater, native, fetches } = fixture({ supported: false });
  updater.start();
  await updater.check();
  await expect(updater.install()).rejects.toThrow();
  expect(updater.state.status).toBe("unsupported");
  expect(fetches()).toBe(0);
  expect(native.checks).toBe(0);
  updater.stop();
});

test("shutdown and overlapping checks cannot start a stale download", async () => {
  let respond!: (response: Response) => void;
  const { updater, native } = fixture({
    fetch: () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  });
  updater.start();
  await updater.check();
  updater.stop();
  respond(new Response(JSON.stringify([release()])));
  await tick();
  expect(native.checks).toBe(0);
});
