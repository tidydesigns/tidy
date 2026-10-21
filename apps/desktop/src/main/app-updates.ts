import { z } from "zod";
import type { AppUpdateState } from "../shared/app-updates";

const repository = "tidydesigns/tidy";
const interval = 30 * 60 * 1000;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;
const releasesSchema = z
  .array(
    z.object({
      tag_name: z.string(),
      draft: z.boolean(),
      prerelease: z.boolean(),
      assets: z.array(
        z.object({ name: z.string(), browser_download_url: z.string(), size: z.number() }),
      ),
    }),
  )
  .max(100);
type Release = z.infer<typeof releasesSchema>[number];
type Candidate = { version: string; feed: string };

function parts(version: string) {
  const match = versionPattern.exec(version);
  if (!match) return null;
  const values = match.slice(1, 4).map(Number);
  const beta = match[4] === undefined ? null : Number(match[4]);
  return [...values, ...(beta === null ? [] : [beta])].every(Number.isSafeInteger)
    ? { values, beta }
    : null;
}

/** Compare only the canonical stable/numbered-beta versions our release pipeline produces. */
export function compareAppVersions(left: string, right: string) {
  const a = parts(left),
    b = parts(right);
  if (!a || !b) throw new Error("Unsupported desktop version.");
  for (let index = 0; index < 3; index++) {
    if (a.values[index] !== b.values[index]) return a.values[index] - b.values[index];
  }
  if (a.beta === b.beta) return 0;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  return a.beta - b.beta;
}

export function selectAppUpdate(
  releases: Release[],
  current: string,
  arch: string,
): Candidate | null {
  if (!parts(current) || !["arm64", "x64"].includes(arch)) return null;
  let selected: Candidate | null = null;
  for (const release of releases) {
    const version = release.tag_name.replace(/^desktop-v/, "");
    if (!release.tag_name.startsWith("desktop-v") || !parts(version) || release.draft) continue;
    const beta = parts(version)!.beta !== null;
    if (release.prerelease !== beta || (parts(current)!.beta === null && beta)) continue;
    if (compareAppVersions(version, selected?.version ?? current) <= 0) continue;
    const base = `https://github.com/${repository}/releases/download/${release.tag_name}/`;
    const feedName = `desktop-update-${arch}.json`;
    const zipName = `Tidy-${version}-mac-${arch}.zip`;
    if (
      ![feedName, zipName].every((name) =>
        release.assets.some(
          (asset) =>
            asset.name === name &&
            asset.browser_download_url === `${base}${name}` &&
            asset.size > 0,
        ),
      )
    )
      continue;
    selected = { version, feed: `${base}${feedName}` };
  }
  return selected;
}

type NativeUpdater = {
  on(event: "error" | "update-downloaded" | "update-not-available", listener: () => void): unknown;
  removeListener(
    event: "error" | "update-downloaded" | "update-not-available",
    listener: () => void,
  ): unknown;
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
};

export class AppUpdates {
  state: AppUpdateState;
  private listeners = new Set<(state: AppUpdateState) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private checking = false;
  private preparing = false;
  private pages = new Map<number, { etag: string; releases: Release[] }>();
  private retryAt = 0;
  private rateLimitFailures = 0;
  private restoreWorkspace?: () => void;
  private readonly unavailable = () => {
    if (this.state.status === "downloading") this.set({ status: "idle" });
  };
  private readonly downloaded = () => {
    if (this.state.status === "downloading")
      this.set({ status: "ready", version: this.state.version });
  };
  private readonly failed = () => {
    if (this.stopped) return;
    // Never expose native paths, signing diagnostics or network responses to the renderer.
    if (this.state.status === "installing") {
      this.restoreWorkspace?.();
      this.restoreWorkspace = undefined;
      this.set({ status: "ready", version: this.state.version, error: "install" });
    } else {
      const error = this.state.status === "downloading" ? "download" : "check";
      this.set({ status: "error", version: this.state.version, error });
    }
  };

  constructor(
    private readonly options: {
      supported: boolean;
      version: string;
      arch: string;
      native: NativeUpdater;
      fetch(url: string, init: RequestInit): Promise<Response>;
      now?(): number;
      prepareInstall(): Promise<void | (() => void)>;
    },
  ) {
    this.state = { status: options.supported ? "idle" : "unsupported" };
  }

  private set(state: AppUpdateState) {
    if (this.stopped) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private isInstalling() {
    return this.state.status === "installing";
  }

  subscribe(listener: (state: AppUpdateState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start() {
    if (this.state.status === "unsupported" || this.timer || this.stopped) return;
    this.options.native.on("error", this.failed);
    this.options.native.on("update-downloaded", this.downloaded);
    this.options.native.on("update-not-available", this.unavailable);
    this.timer = setInterval(() => void this.check(), interval);
    this.timer.unref();
    void this.check();
  }

  async check() {
    if (
      this.stopped ||
      this.checking ||
      !["idle", "error"].includes(this.state.status) ||
      (this.options.now?.() ?? Date.now()) < this.retryAt
    )
      return;
    this.checking = true;
    this.set({ status: "checking" });
    try {
      const discovered: Release[] = [];
      // Include prereleases and tolerate releases being published out of version order.
      for (let page = 1; page <= 3; page++) {
        const cached = this.pages.get(page);
        const response = await this.options.fetch(
          `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              ...(cached ? { "If-None-Match": cached.etag } : {}),
            },
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (response.status === 403 || response.status === 429) {
          const now = this.options.now?.() ?? Date.now();
          const retry = response.headers.get("retry-after");
          const retryAfter =
            retry === null
              ? 0
              : /^\d+$/.test(retry)
                ? now + Number(retry) * 1000
                : Date.parse(retry);
          const reset =
            response.headers.get("x-ratelimit-remaining") === "0"
              ? Number(response.headers.get("x-ratelimit-reset")) * 1000
              : 0;
          // Conditional requests still share an unauthenticated IP's quota. Back off even
          // when GitHub omits retry headers, and prevent manual retries from bypassing it.
          const backoff = interval * 2 ** Math.min(this.rateLimitFailures++, 5);
          this.retryAt = Math.max(
            now + backoff,
            Number.isFinite(retryAfter) ? retryAfter : 0,
            Number.isFinite(reset) ? reset : 0,
          );
          this.set({ status: "idle" });
          return;
        }
        let releases: Release[];
        if (response.status === 304 && cached) releases = cached.releases;
        else {
          if (!response.ok) throw new Error("Release discovery failed.");
          releases = releasesSchema.parse(await response.json());
          const etag = response.headers.get("etag");
          if (etag) this.pages.set(page, { etag, releases });
          else this.pages.delete(page);
        }
        discovered.push(...releases);
        if (releases.length < 100) break;
      }
      if (this.stopped) return;
      this.rateLimitFailures = 0;
      const candidate = selectAppUpdate(discovered, this.options.version, this.options.arch);
      if (!candidate) {
        this.set({ status: "idle" });
        return;
      }
      // Squirrel verifies the downloaded app against the running app's signing identity.
      // The version check above is intentional: default Squirrel feeds do not compare versions.
      this.set({ status: "downloading", version: candidate.version });
      this.options.native.setFeedURL({ url: candidate.feed });
      this.options.native.checkForUpdates();
    } catch {
      this.failed();
    } finally {
      this.checking = false;
    }
  }

  async install() {
    if (this.stopped || this.preparing || this.state.status !== "ready")
      throw new Error("No desktop update is ready.");
    const version = this.state.version;
    this.preparing = true;
    this.set({ status: "installing", version });
    try {
      this.restoreWorkspace = (await this.options.prepareInstall()) ?? undefined;
      if (this.stopped || !this.isInstalling()) throw new Error("Installation cancelled.");
      this.options.native.quitAndInstall();
      // Native updater errors can be emitted synchronously or after this call returns.
      if (!this.isInstalling()) throw new Error("Installation failed.");
    } catch {
      this.restoreWorkspace?.();
      this.restoreWorkspace = undefined;
      this.set({ status: "ready", version, error: "install" });
      throw new Error("The update could not be installed. Please try again.");
    } finally {
      this.preparing = false;
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.options.native.removeListener("error", this.failed);
    this.options.native.removeListener("update-downloaded", this.downloaded);
    this.options.native.removeListener("update-not-available", this.unavailable);
    this.listeners.clear();
  }
}
