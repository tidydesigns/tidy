import {
  harnessNames,
  type HarnessUpdateState,
  type UpdatableHarnessId,
} from "../../shared/contracts/harness-updates";
import {
  inspectHarnessInstallation,
  latestHarnessVersion,
  newerHarnessVersion,
  harnessInstallCommand,
  runMaintenance,
  type HarnessInstallation,
} from "./harness-installation";

const interval = 30 * 60_000;
const retryInterval = 60_000;
const ids = ["codex", "claude", "opencode"] as const;
type Options = {
  installDisabledReason?: string;
  now?: () => number;
  reserve(id: UpdatableHarnessId, options: { allowActiveRuns: boolean }): (() => void) | null;
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
  private nextChecks = new Map<UpdatableHarnessId, number>();
  private failures = new Map<UpdatableHarnessId, number>();
  private generations = new Map<UpdatableHarnessId, number>();

  constructor(private readonly options: Options) {}
  /** Return an isolated renderer snapshot without exposing mutable internal state. */
  get state() {
    return structuredClone(
      ids.flatMap((id) => (this.entries.has(id) ? [this.entries.get(id)!] : [])),
    );
  }
  /** Include queued requests when deciding whether desktop maintenance is pending. */
  get busy() {
    return [...this.entries.values()].some((entry) =>
      ["queued", "installing"].includes(entry.status),
    );
  }
  /** Active maintenance alone blocks an app update; queued requests may wait for a response indefinitely. */
  get installing() {
    return this.active.size > 0;
  }
  /** Subscribe to subsequent state changes and return a listener cleanup callback. */
  subscribe(listener: (state: HarnessUpdateState[]) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Replace one provider's state and broadcast the complete snapshot. */
  private set(entry: HarnessUpdateState) {
    this.entries.set(entry.id, entry);
    this.publish();
  }
  /** Broadcast cloned state so subscribers cannot modify updater bookkeeping. */
  private publish() {
    for (const listener of this.listeners) listener(this.state);
  }
  /** Begin immediate discovery and periodic checks without keeping the process alive. */
  start() {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => void this.check(), retryInterval);
    this.timer.unref();
    void this.check();
  }
  /** Coalesce checks; focus checks are throttled to avoid repeated network requests. */
  check(force = false): Promise<void> {
    if (this.checking) return this.checking;
    if (this.closing) return Promise.resolve();
    const now = (this.options.now ?? Date.now)();
    const due = ids.filter((id) => force || now >= (this.nextChecks.get(id) ?? 0));
    if (!due.length) return Promise.resolve();
    this.checking = this.discover(due).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }
  /** Discover providers independently while preserving updates queued during metadata requests. */
  private async discover(due: readonly UpdatableHarnessId[]) {
    await Promise.all(
      due.map(async (id) => {
        if (["queued", "installing"].includes(this.entries.get(id)?.status ?? "")) return;
        const generation = this.generations.get(id) ?? 0;
        const stale = () =>
          this.closing ||
          (this.generations.get(id) ?? 0) !== generation ||
          ["queued", "installing"].includes(this.entries.get(id)?.status ?? "");
        let installation: HarnessInstallation | null | undefined;
        try {
          installation = await (this.options.inspect ?? inspectHarnessInstallation)(id);
          if (stale()) return;
          // Absence is authoritative even when an old release lookup would fail offline.
          if (!installation) {
            this.installations.delete(id);
            this.entries.delete(id);
            this.failures.delete(id);
            // Missing executables need only a cheap PATH lookup. Notice a newly installed CLI promptly.
            this.nextChecks.set(id, (this.options.now ?? Date.now)() + retryInterval);
            this.publish();
            return;
          }
          const latest = await (this.options.latest ?? latestHarnessVersion)(installation);
          if (stale()) return;
          const available = newerHarnessVersion(latest, installation.version);
          const previous = this.entries.get(id);
          this.installations.set(id, installation);
          this.failures.delete(id);
          this.nextChecks.set(id, (this.options.now ?? Date.now)() + interval);
          this.set({
            id,
            // A background refresh must not erase an explicit install failure or confirmation.
            status:
              available && previous?.status === "error" && previous.latestVersion === latest
                ? "error"
                : available
                  ? "available"
                  : previous?.status === "updated" &&
                      previous.installedVersion === installation.version
                    ? "updated"
                    : "current",
            installedVersion: installation.version,
            latestVersion: latest,
            canInstall: Boolean(installation.command) && !this.options.installDisabledReason,
            ...(available && this.options.installDisabledReason
              ? { message: this.options.installDisabledReason }
              : available && !installation.command
                ? { message: "Update this installation with its package manager." }
                : available && previous?.status === "error" && previous.latestVersion === latest
                  ? { message: previous.message }
                  : {}),
          });
        } catch {
          if (stale()) return;
          const failures = (this.failures.get(id) ?? 0) + 1;
          this.failures.set(id, failures);
          this.nextChecks.set(
            id,
            (this.options.now ?? Date.now)() +
              Math.min(interval, retryInterval * 2 ** Math.min(failures - 1, 5)),
          );
          const previous = this.entries.get(id);
          const known = this.installations.get(id);
          // Never reuse release metadata for a different package or release channel.
          const sameSource =
            !installation ||
            (known &&
              installation.packageName === known.packageName &&
              installation.channel === known.channel &&
              JSON.stringify(installation.brew) === JSON.stringify(known.brew));
          const checkError = "Couldn’t check for updates. Tidy will try again automatically.";
          if (previous && previous.status !== "check-error" && sameSource) {
            const available =
              installation && newerHarnessVersion(previous.latestVersion, installation.version);
            const status: HarnessUpdateState["status"] = installation
              ? available
                ? previous.status === "error"
                  ? "error"
                  : "available"
                : previous.status === "updated" &&
                    previous.installedVersion === installation.version
                  ? "updated"
                  : "current"
              : previous.status;
            this.set({
              ...previous,
              status,
              ...(installation ? { installedVersion: installation.version } : {}),
              canInstall:
                Boolean(installation?.command) &&
                !this.options.installDisabledReason &&
                installation?.executable === known?.executable &&
                JSON.stringify(installation?.command) === JSON.stringify(known?.command),
              message: status === "current" ? undefined : previous.message,
              checkError,
            });
          } else {
            this.installations.delete(id);
            this.set({
              id,
              status: "check-error",
              installedVersion: installation?.version ?? "",
              latestVersion: "",
              canInstall: false,
              checkError,
            });
          }
        }
      }),
    );
  }
  /** Queue once and return immediately; the user need not keep the project or thread open. */
  install(id: UpdatableHarnessId) {
    if (this.closing) throw new Error("Tidy is closing.");
    if (this.options.installDisabledReason) throw new Error(this.options.installDisabledReason);
    const entry = this.entries.get(id);
    if (entry && ["queued", "installing"].includes(entry.status)) return;
    if (!entry || !entry.canInstall || !["available", "error"].includes(entry.status))
      throw new Error("No installable update is available for this harness.");
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.set({
      ...entry,
      status: "queued",
      waitReason: this.active.size ? "installer" : "turn",
      message: undefined,
      checkError: undefined,
    });
    if (!this.queueTimer) {
      this.queueTimer = setInterval(() => this.pump(), 1000);
      this.queueTimer.unref();
    }
    this.pump();
  }
  /** Reserve an eligible harness and run one installer, skipping providers with active turns. */
  private pump() {
    if (this.closing) return;
    // Serialize package managers, which commonly share global locks and install directories.
    if (this.active.size) {
      this.queuedBehindInstaller();
      return;
    }
    for (const entry of this.entries.values()) {
      if (entry.status !== "queued") continue;
      const release = this.options.reserve(entry.id, {
        allowActiveRuns: this.installations.get(entry.id)?.canUpdateWhileRunning === true,
      });
      if (!release) {
        if (entry.waitReason !== "turn") this.set({ ...entry, waitReason: "turn" });
        continue;
      }
      // Register the task before publishing so listeners observe installing=true immediately.
      this.entries.set(entry.id, { ...entry, status: "installing", waitReason: undefined });
      const task = this.apply(entry).finally(() => {
        release();
        this.active.delete(entry.id);
        this.pump();
      });
      this.active.set(entry.id, task);
      this.publish();
      this.queuedBehindInstaller();
      return;
    }
    if (![...this.entries.values()].some((entry) => entry.status === "queued")) {
      clearInterval(this.queueTimer);
      this.queueTimer = undefined;
    }
  }
  /** Explain the shared installer wait independently of a provider's own active responses. */
  private queuedBehindInstaller() {
    for (const entry of this.entries.values()) {
      if (entry.status === "queued" && entry.waitReason !== "installer")
        this.set({ ...entry, waitReason: "installer" });
    }
  }
  /** Revalidate the installation, apply its update and verify the version before success. */
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
          installation.packageName !== previous.packageName ||
          installation.channel !== previous.channel ||
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
        waitReason: undefined,
      });
    } catch {
      // Updater output can contain local paths/configuration. Never forward it to the renderer.
      this.set({
        ...entry,
        status: "error",
        waitReason: undefined,
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
