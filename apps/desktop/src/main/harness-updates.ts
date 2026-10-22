import {
  harnessNames,
  type HarnessUpdateState,
  type UpdatableHarnessId,
} from "../shared/harness-updates";
import {
  inspectHarnessInstallation,
  latestHarnessVersion,
  newerHarnessVersion,
  harnessInstallCommand,
  runMaintenance,
  type HarnessInstallation,
} from "./harness-installation";

const interval = 30 * 60_000;
const ids = ["codex", "claude", "opencode"] as const;
type Options = {
  reserve(id: UpdatableHarnessId): (() => void) | null;
  inspect?: typeof inspectHarnessInstallation;
  latest?: typeof latestHarnessVersion;
  run?: typeof runMaintenance;
  installed?(id: UpdatableHarnessId): void;
};

/** Background discovery never installs anything. Only an explicit install request queues work. */
export class HarnessUpdates {
  private entries = new Map<UpdatableHarnessId, HarnessUpdateState>();
  private installations = new Map<UpdatableHarnessId, HarnessInstallation>();
  private listeners = new Set<(state: HarnessUpdateState[]) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private queueTimer?: ReturnType<typeof setInterval>;
  private checking?: Promise<void>;
  private active = new Map<UpdatableHarnessId, Promise<void>>();
  private closing = false;
  private lastCheck = 0;
  private generations = new Map<UpdatableHarnessId, number>();

  constructor(private readonly options: Options) {}
  get state() {
    return structuredClone([...this.entries.values()]);
  }
  get busy() {
    return [...this.entries.values()].some((entry) =>
      ["queued", "installing"].includes(entry.status),
    );
  }
  subscribe(listener: (state: HarnessUpdateState[]) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private set(entry: HarnessUpdateState) {
    this.entries.set(entry.id, entry);
    this.publish();
  }
  private publish() {
    for (const listener of this.listeners) listener(this.state);
  }
  start() {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => void this.check(), interval);
    this.timer.unref();
    void this.check();
  }
  /** Coalesce checks; focus checks are throttled to avoid repeated network requests. */
  check(force = false): Promise<void> {
    if (this.checking) return this.checking;
    if (this.closing || (!force && Date.now() - this.lastCheck < interval))
      return Promise.resolve();
    this.lastCheck = Date.now();
    this.checking = this.discover().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }
  private async discover() {
    await Promise.all(
      ids.map(async (id) => {
        if (["queued", "installing"].includes(this.entries.get(id)?.status ?? "")) return;
        const generation = this.generations.get(id) ?? 0;
        try {
          const installation = await (this.options.inspect ?? inspectHarnessInstallation)(id);
          const latest = installation
            ? await (this.options.latest ?? latestHarnessVersion)(installation)
            : undefined;
          // A user may have clicked Update while this metadata request was in flight.
          if (
            this.closing ||
            (this.generations.get(id) ?? 0) !== generation ||
            ["queued", "installing"].includes(this.entries.get(id)?.status ?? "")
          )
            return;
          if (!installation || !latest) {
            this.installations.delete(id);
            this.entries.delete(id);
            this.publish();
            return;
          }
          this.installations.set(id, installation);
          const available = newerHarnessVersion(latest, installation.version);
          this.set({
            id,
            status: available ? "available" : "current",
            installedVersion: installation.version,
            latestVersion: latest,
            canInstall: Boolean(installation.command),
            ...(available && !installation.command
              ? { message: "Update this installation with its package manager." }
              : {}),
          });
        } catch {
          // Offline discovery is quiet and preserves previously discovered actionable updates.
        }
      }),
    );
  }
  /** Queue once and return immediately; the user need not keep the project or thread open. */
  install(id: UpdatableHarnessId) {
    if (this.closing) throw new Error("Tidy is closing.");
    const entry = this.entries.get(id);
    if (entry && ["queued", "installing"].includes(entry.status)) return;
    if (!entry || !entry.canInstall || !["available", "error"].includes(entry.status))
      throw new Error("No installable update is available for this harness.");
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.set({ ...entry, status: "queued", message: undefined });
    if (!this.queueTimer) {
      this.queueTimer = setInterval(() => this.pump(), 1000);
      this.queueTimer.unref();
    }
    this.pump();
  }
  private pump() {
    if (this.closing) return;
    // Serialize package managers, which commonly share global locks and install directories.
    if (this.active.size) return;
    for (const entry of this.entries.values()) {
      if (entry.status !== "queued") continue;
      const release = this.options.reserve(entry.id);
      if (!release) continue;
      this.set({ ...entry, status: "installing" });
      const task = this.apply(entry).finally(() => {
        release();
        this.active.delete(entry.id);
        this.pump();
      });
      this.active.set(entry.id, task);
      return;
    }
    if (![...this.entries.values()].some((entry) => entry.status === "queued")) {
      clearInterval(this.queueTimer);
      this.queueTimer = undefined;
    }
  }
  private async apply(entry: HarnessUpdateState) {
    try {
      // Re-resolve just before install: PATH, symlinks, version and install method can change.
      const installation = await (this.options.inspect ?? inspectHarnessInstallation)(entry.id);
      const previous = this.installations.get(entry.id);
      if (!installation) throw new Error("The harness is no longer installed.");
      if (newerHarnessVersion(entry.latestVersion, installation.version)) {
        if (
          !previous ||
          installation.executable !== previous.executable ||
          JSON.stringify(installation.command) !== JSON.stringify(previous.command)
        )
          throw new Error("The harness installation changed. Check again after restarting Tidy.");
        await (this.options.run ?? runMaintenance)(
          harnessInstallCommand(installation, entry.latestVersion),
          5 * 60_000,
        );
      }
      // Native updaters can replace a symlink and can advance beyond the discovered version.
      const verified = await (this.options.inspect ?? inspectHarnessInstallation)(entry.id);
      if (!verified || newerHarnessVersion(entry.latestVersion, verified.version))
        throw new Error(
          "The updater did not install the available version. Check your CLI’s update policy or package manager permissions, then retry.",
        );
      this.installations.set(entry.id, verified);
      this.options.installed?.(entry.id);
      this.set({
        ...entry,
        status: "updated",
        installedVersion: verified.version,
        latestVersion: verified.version,
      });
    } catch {
      // Updater output can contain local paths/configuration. Never forward it to the renderer.
      this.set({
        ...entry,
        status: "error",
        message: `Couldn’t update ${harnessNames[entry.id]}. Check your CLI’s update policy, network connection and package manager permissions, then retry.`,
      });
    }
  }
  /** Cancel queued requests; let active installers finish before allowing an app restart/quit. */
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    clearInterval(this.queueTimer);
    await Promise.all([...this.active.values()]);
    await this.checking;
    this.listeners.clear();
  }
}
