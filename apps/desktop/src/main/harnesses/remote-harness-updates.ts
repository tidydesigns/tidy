import type {
  HarnessUpdateState,
  UpdatableHarnessId,
} from "../../shared/contracts/harness-updates";
import type { RemoteClient } from "../remote/client";
import { HarnessUpdates } from "./harness-updates";

/** Maintenance belongs to the backend that owns the running providers. */
export class RemoteHarnessUpdates {
  state: HarnessUpdateState[] = [];
  private listeners = new Set<(state: HarnessUpdateState[]) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private checking?: Promise<void>;
  private stopped = false;
  private fallback?: HarnessUpdates;
  private generation = 0;
  constructor(private client: RemoteClient) {}
  get busy() {
    return this.state.some((entry) => entry.status === "installing" || entry.status === "queued");
  }
  get installing() {
    return this.state.some((entry) => entry.status === "installing");
  }
  subscribe(listener: (state: HarnessUpdateState[]) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(state: HarnessUpdateState[]) {
    if (this.stopped) return;
    this.state = state;
    for (const listener of this.listeners) listener(structuredClone(state));
  }
  start() {
    void this.check();
  }
  check(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.checking) return this.checking;
    clearTimeout(this.timer);
    const generation = this.generation;
    const status = this.client.status;
    const legacy = status.kind === "connected" && !status.capabilities?.includes("harness-updates");
    if (legacy && !this.fallback) {
      this.fallback = new HarnessUpdates({
        installDisabledReason:
          "Update the background backend to install CLI updates here, or use your CLI’s package manager.",
        reserve: () => null,
      });
      this.fallback.subscribe((state) => this.publish(state));
    }
    this.checking = (
      legacy
        ? this.fallback!.check().then(() => this.fallback!.state)
        : this.client.operation("backend-harness-update-state", { refresh: true })
    )
      .then((state) => {
        if (generation === this.generation) this.publish(state);
      })
      .catch(() => {
        if (generation !== this.generation || this.stopped) return;
        const checkError =
          "Couldn’t contact the backend to check CLI updates. Tidy will retry automatically.";
        this.publish(
          this.state.length
            ? this.state.map((entry) => ({ ...entry, checkError }))
            : (["codex", "claude", "opencode"] as const).map((id) => ({
                id,
                status: "check-error",
                installedVersion: "",
                latestVersion: "",
                canInstall: false,
                checkError,
              })),
        );
      })
      .finally(() => {
        this.checking = undefined;
        if (!this.stopped) {
          this.timer = setTimeout(
            () => {
              void this.check();
            },
            this.busy ? 1000 : 60_000,
          );
          this.timer.unref();
        }
      });
    return this.checking;
  }
  async install(id: UpdatableHarnessId) {
    if (this.stopped) throw new Error("Tidy is closing.");
    const generation = ++this.generation;
    const state = await this.client.operation("backend-install-harness-update", id);
    if (generation === this.generation) this.publish(state);
    await this.check();
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.listeners.clear();
    await this.fallback?.close();
    // Disconnecting a desktop must not cancel an accepted backend installer.
  }
}
