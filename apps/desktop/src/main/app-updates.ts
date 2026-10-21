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
    this.set({ status: "error" });
  };

  constructor(
    private readonly options: {
      supported: boolean;
      version: string;
      arch: string;
      native: NativeUpdater;
      fetch(url: string, init: RequestInit): Promise<Response>;
      prepareInstall(): Promise<void>;
    },
  ) {
    this.state = { status: options.supported ? "idle" : "unsupported" };
  }

  private set(state: AppUpdateState) {
    if (this.stopped) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
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
    if (this.stopped || this.checking || !["idle", "error"].includes(this.state.status)) return;
    this.checking = true;
    this.set({ status: "checking" });
    try {
      const discovered: Release[] = [];
      // Include prereleases and tolerate releases being published out of version order.
      for (let page = 1; page <= 3; page++) {
        const response = await this.options.fetch(
          `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
          {
            headers: { Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (!response.ok) throw new Error("Release discovery failed.");
        const releases = releasesSchema.parse(await response.json());
        discovered.push(...releases);
        if (releases.length < 100) break;
      }
      if (this.stopped) return;
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
    if (this.stopped || this.state.status !== "ready")
      throw new Error("No desktop update is ready.");
    const version = this.state.version;
    this.set({ status: "installing", version });
    try {
      await this.options.prepareInstall();
      this.options.native.quitAndInstall();
    } catch {
      this.set({ status: "ready", version });
      throw new Error("The update could not be installed. Please try again.");
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
