import { describe, expect, test } from "bun:test";
import { createDownloadHandler, selectLatestBeta } from "./download";
import worker from "./index";

const repository = "tidydesigns/tidy";
function release(version, overrides = {}) {
  const tag = `desktop-v${version}`;
  const names = [
    `Tidy-${version}-mac-arm64.dmg`,
    `Tidy-${version}-mac-arm64.dmg.sha256`,
    "desktop-release.json",
  ];
  return {
    tag_name: tag,
    draft: false,
    prerelease: true,
    assets: names.map((name) => ({
      name,
      size: 100,
      state: "uploaded",
      browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
    })),
    ...overrides,
  };
}
const click = (method = "GET", query = "") =>
  new Request(`https://tidydesign.co/download/mac${query}`, { method });
const page = (data, headers) => Response.json(data, { headers });

describe("latest desktop beta download", () => {
  test("selects numeric beta and base versions, ignoring release order and unrelated channels", () => {
    const chosen = selectLatestBeta(
      [
        release("0.1.0-beta.9"),
        release("0.1.0-beta.10"),
        release("0.2.0-beta.1"),
        release("9.0.0-beta.1", { draft: true }),
        release("9.0.0-beta.2", { prerelease: false }),
        release("9.0.0-rc.1"),
        release("9.0.0"),
        release("9.0.0-beta.3", { tag_name: "extension-v9.0.0-beta.3" }),
      ],
      repository,
    );
    expect(chosen?.url).toContain("desktop-v0.2.0-beta.1/Tidy-0.2.0-beta.1-mac-arm64.dmg");
    expect(
      selectLatestBeta([release("0.1.0-beta.9"), release("0.1.0-beta.10")], repository)?.version,
    ).toEqual([0, 1, 0, 10]);
  });

  test("rejects incomplete publication, foreign URLs, unsupported architectures and unsafe versions", () => {
    const value = release("0.1.0-beta.10");
    for (const assets of [
      value.assets.slice(0, 1),
      value.assets.map((a) => ({ ...a, state: "new" })),
      value.assets.map((a) => ({ ...a, size: 0 })),
      value.assets.map((a) => ({
        ...a,
        browser_download_url: a.browser_download_url.replace("github.com", "github.com.evil.test"),
      })),
      value.assets.map((a) => ({ ...a, name: a.name.replace("arm64", "x64") })),
    ])
      expect(selectLatestBeta([{ ...value, assets }], repository)).toBeNull();
    expect(
      selectLatestBeta(
        [release("0.1.0-beta.9007199254740992"), release("0.1.0-beta.01"), null],
        repository,
      ),
    ).toBeNull();
  });

  test("redirects directly to the installer, shares discovery and refreshes after a minute", async () => {
    let now = 0,
      calls = 0,
      version = "0.1.0-beta.9";
    const handler = createDownloadHandler(
      async () => {
        calls++;
        return page([release(version)]);
      },
      () => now,
    );
    const responses = await Promise.all([
      handler(click()),
      handler(click("HEAD")),
      handler(click("GET", "?url=https://evil.test&arch=x64")),
    ]);
    expect(calls).toBe(1);
    for (const response of responses) {
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("Tidy-0.1.0-beta.9-mac-arm64.dmg");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
    version = "0.1.0-beta.10";
    now = 59_999;
    await handler(click());
    expect(calls).toBe(1);
    now = 60_000;
    expect((await handler(click())).headers.get("location")).toContain("beta.10");
    expect(calls).toBe(2);
  });

  test("paginates fixed GitHub URLs, chooses the newest complete beta and bounds pagination", async () => {
    const urls = [];
    const handler = createDownloadHandler(async (url, init) => {
      urls.push(url);
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-token");
      return page([release(`0.1.0-beta.${urls.length}`)], {
        link: '<https://evil.test/stolen>; rel="next"',
      });
    });
    const result = await handler(click(), { GITHUB_RELEASES_TOKEN: "fixture-token" });
    expect(urls).toEqual(
      [1, 2, 3].map(
        (p) => `https://api.github.com/repos/${repository}/releases?per_page=100&page=${p}`,
      ),
    );
    expect(result.headers.get("location")).toContain("beta.3");
  });

  test("fails safely on missing releases, API failures and invalid data without caching errors", async () => {
    for (const respond of [
      () => page([]),
      () => page({ error: "invalid" }),
      () => new Response("broken JSON"),
      () => new Response("private upstream error", { status: 403 }),
      () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } }),
      () => {
        throw new Error("private credential detail");
      },
    ]) {
      let calls = 0;
      const handler = createDownloadHandler(async () => {
        calls++;
        return respond();
      });
      const response = await handler(click());
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("30");
      expect(await response.text()).not.toContain("private");
      expect(await (await handler(click("HEAD"))).text()).toBe("");
      expect(calls).toBe(2);
    }
  });

  test("does not serve an expired installer when refresh fails", async () => {
    let now = 0;
    const handler = createDownloadHandler(
      async () => (now ? new Response(null, { status: 503 }) : page([release("0.1.0-beta.1")])),
      () => now,
    );
    expect((await handler(click())).status).toBe(302);
    now = 60_000;
    expect((await handler(click())).status).toBe(503);
  });

  test("uses only the configured public repository and never forwards visitor credentials", async () => {
    const configured = "example/desktop";
    const value = release("1.0.0-beta.1");
    value.assets = value.assets.map((asset) => ({
      ...asset,
      browser_download_url: asset.browser_download_url.replace(repository, configured),
    }));
    const handler = createDownloadHandler(async (url, init) => {
      expect(url).toBe(`https://api.github.com/repos/${configured}/releases?per_page=100&page=1`);
      const headers = new Headers(init.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      return page([value]);
    });
    const request = new Request("https://tidydesign.co/download/mac?repository=evil/repo", {
      headers: { Authorization: "Bearer visitor-fixture", Cookie: "session=visitor-fixture" },
    });
    const response = await handler(request, { DESKTOP_RELEASE_REPOSITORY: configured });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith(
      `https://github.com/${configured}/releases/download/`,
    );
  });

  test("bounds response size and rejects methods and repository injection before network access", async () => {
    let calls = 0;
    const handler = createDownloadHandler(async () => {
      calls++;
      return new Response(new Uint8Array(8 * 1024 * 1024 + 1));
    });
    expect((await handler(click("POST"))).status).toBe(405);
    expect(
      (await handler(click(), { DESKTOP_RELEASE_REPOSITORY: "../evil?token=secret" })).status,
    ).toBe(503);
    expect(calls).toBe(0);
    expect((await handler(click())).status).toBe(503);
  });

  test("keeps regular pages on the assets binding and never fetches GitHub for them", async () => {
    const response = await worker.fetch(new Request("https://tidydesign.co/changelog"), {
      ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname) },
    });
    expect(await response.text()).toBe("/changelog");
  });
});
