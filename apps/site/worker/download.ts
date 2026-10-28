const defaultRepository = "tidydesigns/tidy";
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const betaPattern = /^desktop-v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*))$/;
const freshFor = 60_000;
const pageLimit = 3;
const bodyLimit = 8 * 1024 * 1024;

export type DownloadEnvironment = {
  DESKTOP_RELEASE_REPOSITORY?: string;
  GITHUB_RELEASES_TOKEN?: string;
};
type Candidate = { url: string; version: number[] };
type FetchRelease = (url: string, init: RequestInit) => Promise<Response>;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function newer(left: Candidate, right: Candidate) {
  for (let index = 0; index < 4; index++) {
    if (left.version[index] !== right.version[index])
      return left.version[index] > right.version[index];
  }
  return false;
}

/** Match the release workflow's exact beta, installer and publication metadata. */
export function selectLatestBeta(releases: unknown[], repository: string): Candidate | null {
  let selected: Candidate | null = null;
  for (const release of releases) {
    if (
      !record(release) ||
      release.draft !== false ||
      release.prerelease !== true ||
      typeof release.tag_name !== "string" ||
      !Array.isArray(release.assets)
    )
      continue;
    const match = betaPattern.exec(release.tag_name);
    if (!match) continue;
    const version = match.slice(2).map(Number);
    if (!version.every(Number.isSafeInteger)) continue;
    const base = `https://github.com/${repository}/releases/download/${release.tag_name}/`;
    const installer = `Tidy-${match[1]}-mac-arm64.dmg`;
    const assets = release.assets;
    if (
      ![installer, `${installer}.sha256`, "desktop-release.json"].every((name) =>
        assets.some(
          (asset: unknown) =>
            record(asset) &&
            asset.name === name &&
            asset.state === "uploaded" &&
            Number.isSafeInteger(asset.size) &&
            typeof asset.size === "number" &&
            asset.size > 0 &&
            asset.browser_download_url === `${base}${name}`,
        ),
      )
    )
      continue;
    const candidate = { version, url: `${base}${installer}` };
    if (!selected || newer(candidate, selected)) selected = candidate;
  }
  return selected;
}

async function releasePage(response: Response): Promise<unknown[]> {
  if (!response.ok || !response.body) throw new Error("Release lookup unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > bodyLimit) throw new Error("Release response too large.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(data) || data.length > 100) throw new Error("Invalid release response.");
  return data;
}

async function lookup(repository: string, token: string | undefined, fetchRelease: FetchRelease) {
  let selected: Candidate | null = null;
  // One deadline covers pagination and streaming; never follow an upstream-provided URL.
  const signal = AbortSignal.timeout(8_000);
  for (let page = 1; page <= pageLimit; page++) {
    const response = await fetchRelease(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Tidy-beta-download",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        // Workers support manual/follow, not redirect:"error". releasePage
        // rejects every non-2xx response, including redirects, without following it.
        redirect: "manual",
        signal,
      },
    );
    const candidate = selectLatestBeta(await releasePage(response), repository);
    if (candidate && (!selected || newer(candidate, selected))) selected = candidate;
    if (!response.headers.get("link")?.includes('rel="next"')) break;
  }
  if (!selected) throw new Error("No complete macOS beta release.");
  return selected.url;
}

/** Cache successful discovery briefly and coalesce clicks; never pin the browser to a version. */
export function createDownloadHandler(fetchRelease: FetchRelease = fetch, now = Date.now) {
  const cached = new Map<string, { url: string; expires: number }>();
  const pending = new Map<string, Promise<string>>();
  return async (request: Request, env: DownloadEnvironment = {}): Promise<Response> => {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (!["GET", "HEAD"].includes(request.method)) {
      headers.set("Allow", "GET, HEAD");
      return new Response(null, { status: 405, headers });
    }
    const repository = env.DESKTOP_RELEASE_REPOSITORY || defaultRepository;
    if (repository.length > 200 || !repositoryPattern.test(repository))
      return new Response(
        request.method === "HEAD" ? null : "Download service is not configured.",
        { status: 503, headers },
      );
    try {
      let entry = cached.get(repository);
      if (!entry || entry.expires <= now()) {
        let discovery = pending.get(repository);
        if (!discovery) {
          discovery = lookup(repository, env.GITHUB_RELEASES_TOKEN, fetchRelease)
            .then((url) => {
              // The repository is operator configuration, never request input.
              if (cached.size >= 8) cached.delete(cached.keys().next().value!);
              cached.set(repository, { url, expires: now() + freshFor });
              return url;
            })
            .finally(() => pending.delete(repository));
          pending.set(repository, discovery);
        }
        const url = await discovery;
        entry = { url, expires: now() + freshFor };
      }
      headers.set("Location", entry.url);
      return new Response(null, { status: 302, headers });
    } catch {
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Retry-After", "30");
      headers.set(
        "Content-Security-Policy",
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tidy beta download unavailable</title></head><body><main><h1>The beta download is temporarily unavailable.</h1><p>Please try again shortly, or <a href="https://github.com/${repository}/releases">download a beta from GitHub releases</a>.</p></main></body></html>`;
      return new Response(request.method === "HEAD" ? null : html, { status: 503, headers });
    }
  };
}
