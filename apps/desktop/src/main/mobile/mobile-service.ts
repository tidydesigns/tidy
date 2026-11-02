import { randomUUID } from "node:crypto";
import type {
  MobileBuildScope,
  MobileCommand,
  MobileDevice,
  MobileFrame,
  MobileInput,
  MobileSession,
  MobileState,
} from "../../shared/contracts/mobile";
import { connectAndroid, connectIOS, type DeviceBridge, type DeviceFrame } from "./bridges";
import { discoverDevices, discoverTargets } from "./discovery";
import { IOSRuntime } from "./runtime";
import { runMobileApp, type RunningApp } from "./runner";
import type { MobileProcess } from "./process";

type Session = {
  state: MobileSession;
  device: MobileDevice;
  lifetime: AbortController;
  run?: AbortController;
  task?: Promise<void>;
  stopping?: Promise<unknown>;
  app?: RunningApp;
  bridge?: DeviceBridge;
  stopCapture?: () => void;
  frame?: MobileFrame;
  lastFrame?: DeviceFrame;
  sequence: number;
  demand: number;
  waiters: Set<() => void>;
  pendingFrames: number;
  inputs: Promise<void>;
  pendingInputs: number;
  touch?: Extract<MobileInput["event"], { kind: "touch" }>;
};
type Project = {
  root: string;
  session?: Session;
  catalog?: Promise<MobileState>;
  catalogScope?: string;
  checked: number;
  cleanup?: Promise<unknown>;
};
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.slice(-1000)
    : "The device is unavailable. Retry the connection.";
const defaultIntegrations = {
  devices: discoverDevices,
  targets: discoverTargets,
  ios: connectIOS,
  android: connectAndroid,
  run: runMobileApp,
};

/** Device state belongs to the host, never to the panel's mount/visibility lifecycle. */
export class MobileService {
  private readonly projects = new Map<string, Project>();
  private readonly runtime = new IOSRuntime();
  private closing = false;
  private devices?: Promise<Pick<MobileState, "devices" | "requirements">>;
  private deviceChecked = 0;
  private readonly maintenance: ReturnType<typeof setInterval>;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly emulators = new Set<MobileProcess>();

  constructor(
    private readonly authorize: (projectId: string) => Promise<string>,
    private readonly integrations = defaultIntegrations,
    private readonly targetRoot?: (scope: MobileBuildScope) => Promise<string>,
  ) {
    this.maintenance = setInterval(() => {
      for (const project of this.projects.values()) {
        const session = project.session;
        if (session?.stopCapture && Date.now() - session.demand > 1500) {
          this.pauseCapture(session);
        }
      }
    }, 1000);
    this.maintenance.unref();
  }

  get activeCount() {
    return [...this.projects.values()].filter((project) => project.session).length;
  }
  private track(task: Promise<unknown>) {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }
  private async project(projectId: string) {
    if (this.closing) throw new Error("Devices are closing.");
    const root = await this.authorize(projectId);
    if (this.closing) throw new Error("Devices are closing.");
    let project = this.projects.get(projectId);
    if (!project) {
      if (this.projects.size >= 64)
        throw new Error("Close an unused project before connecting another device.");
      project = { root, checked: 0 };
      this.projects.set(projectId, project);
    }
    return project;
  }

  async state(input: MobileBuildScope & { refresh?: boolean }): Promise<MobileState> {
    const project = await this.project(input.projectId);
    if (input.refresh || !this.devices || Date.now() - this.deviceChecked > 15_000) {
      this.deviceChecked = Date.now();
      this.devices = this.integrations.devices();
    }
    const devices = this.devices;
    const catalogScope = JSON.stringify([input.threadId, input.threadProjectId]);
    if (
      input.refresh ||
      !project.catalog ||
      project.catalogScope !== catalogScope ||
      Date.now() - project.checked > 60_000
    ) {
      project.checked = Date.now();
      project.catalogScope = catalogScope;
      project.catalog = (async () => {
        const root = this.targetRoot ? await this.targetRoot(input) : project.root;
        const targets = await this.integrations.targets(root);
        return { devices: [], targets, requirements: [], session: null };
      })();
    }
    const [catalog, discovered] = await Promise.all([project.catalog, devices]);
    return { ...catalog!, ...discovered!, session: project.session?.state ?? null };
  }

  private current(project: Project, sessionId: string) {
    const session = project.session;
    if (!session || session.state.id !== sessionId || session.lifetime.signal.aborted)
      throw new Error("This device session ended. Reconnect the device.");
    return session;
  }

  private pauseCapture(session: Session) {
    session.stopCapture?.();
    session.stopCapture = undefined;
    session.lastFrame = undefined;
    if (session.touch && session.bridge) {
      const touch = session.touch;
      session.touch = undefined;
      void session.bridge.input({ ...touch, phase: "up" }).catch(() => {});
    }
    for (const waiter of session.waiters) waiter();
  }
  private disconnect(project: Project) {
    const session = project.session;
    if (!session) return;
    project.session = undefined;
    session.run?.abort(new Error("App run stopped."));
    project.cleanup = Promise.allSettled([session.task, session.stopping, session.app?.stop()]);
    this.track(project.cleanup);
    this.pauseCapture(session);
    session.lifetime.abort(new Error("Device session ended."));
    session.bridge?.close();
  }

  async command(command: MobileCommand): Promise<MobileState> {
    const project = await this.project(command.projectId);
    if (command.kind === "connect") {
      const catalog = await this.state(command);
      const device = catalog.devices.find((device) => device.id === command.deviceId);
      if (!device) throw new Error("This device is unavailable. Refresh the device list.");
      const requirement = catalog.requirements.find(
        (requirement) => requirement.platform === device.platform,
      );
      if (!requirement?.ready)
        throw new Error(requirement?.message ?? "Device tools are unavailable.");
      // One controller per simulator: separate projects cannot interleave pointer/key input.
      for (const [id, other] of this.projects) {
        if (id !== command.projectId && other.session?.device.id === device.id)
          throw new Error(
            "This device is connected to another Tidy project. Disconnect it there or choose another device.",
          );
      }
      if (project.session?.device.id === device.id && project.session.state.phase !== "error")
        return catalog;
      this.disconnect(project);
      const session: Session = {
        state: {
          id: randomUUID(),
          deviceId: device.id,
          phase: "starting",
          message: `Starting ${device.name}…`,
        },
        device,
        lifetime: new AbortController(),
        sequence: 0,
        demand: 0,
        waiters: new Set(),
        pendingFrames: 0,
        inputs: Promise.resolve(),
        pendingInputs: 0,
      };
      project.session = session;
      const progress = (message: string) => {
        if (project.session === session) session.state.message = message;
      };
      this.track(
        (async () => {
          try {
            await project.cleanup;
            session.lifetime.signal.throwIfAborted();
            const bridge =
              device.platform === "ios"
                ? await this.integrations.ios({
                    device,
                    runtime: this.runtime,
                    signal: session.lifetime.signal,
                    progress,
                  })
                : await this.integrations.android({
                    device,
                    signal: session.lifetime.signal,
                    progress,
                    owned: (child) => {
                      this.emulators.add(child);
                      void child.done.finally(() => this.emulators.delete(child)).catch(() => {});
                    },
                  });
            if (project.session !== session || this.closing) {
              bridge.close();
              return;
            }
            session.bridge = bridge;
            session.state.phase = "ready";
            session.state.message = "Connected";
            this.deviceChecked = 0;
          } catch (error) {
            if (project.session !== session || this.closing) return;
            session.state.phase = "error";
            session.state.message = errorText(error);
          }
        })(),
      );
    } else {
      const session = this.current(project, command.sessionId);
      if (command.kind === "disconnect") this.disconnect(project);
      else if (command.kind === "stop") {
        session.run?.abort(new Error("App run stopped."));
        session.stopping = Promise.resolve(session.app?.stop());
        this.track(session.stopping);
        session.app = undefined;
        if (session.state.run) {
          session.state.run.phase = "stopped";
          session.state.run.message = "Run stopped";
        }
      } else if (command.kind === "run") {
        if (!session.bridge || session.state.phase !== "ready")
          throw new Error("Wait for the device to connect before running an app.");
        if (session.state.run?.phase === "building")
          throw new Error("This app is already building.");
        session.run?.abort(new Error("Starting a new app run."));
        const stopping = Promise.allSettled([session.task, session.stopping, session.app?.stop()]);
        session.app = undefined;
        const run = new AbortController();
        session.run = run;
        const state = {
          id: randomUUID(),
          targetId: command.targetId,
          phase: "building" as "building" | "running" | "stopped" | "failed",
          message: "Preparing app…",
          output: "",
        };
        session.state.run = state;
        const active = () =>
          project.session === session && session.state.run === state && !run.signal.aborted;
        this.track(
          (session.task = (async () => {
            await stopping;
            const root = this.targetRoot ? await this.targetRoot(command) : project.root;
            const targets = await this.integrations.targets(root);
            const target = targets.find(
              (target) =>
                target.id === command.targetId &&
                target.platforms.includes(session.device.platform),
            );
            if (!target)
              throw new Error("The app target moved. Refresh Devices and choose an app again.");
            if (!active()) throw new Error("This app run ended.");
            return this.integrations.run({
              root,
              target,
              device: session.device,
              serial: session.bridge!.serial,
              signal: AbortSignal.any([run.signal, session.lifetime.signal]),
              output: (text) => {
                if (active()) state.output = (state.output + text).slice(-64_000);
              },
              stage: (message) => {
                if (active()) state.message = message;
              },
              running: () => {
                if (active()) {
                  state.phase = "running";
                  state.message = "App running";
                }
              },
              failed: (error) => {
                if (active()) {
                  state.phase = "failed";
                  state.message = errorText(error);
                  run.abort(error);
                }
              },
            });
          })()
            .then(async (app) => {
              if (active()) session.app = app;
              else await app.stop();
            })
            .catch((error: unknown) => {
              if (active()) {
                state.phase = "failed";
                state.message = errorText(error);
              }
            })),
        );
      } else {
        if (!session.bridge || session.state.phase !== "ready")
          throw new Error("Reconnect the device before controlling it.");
        if (command.kind === "reload") {
          if (!session.app || session.state.run?.phase !== "running")
            throw new Error("Run an app before reloading it.");
          await session.app.reload();
        } else await session.bridge[command.kind]();
      }
    }
    return this.state(command);
  }

  async frame(input: {
    projectId: string;
    sessionId: string;
    after: number;
  }): Promise<MobileFrame | null> {
    const project = await this.project(input.projectId);
    const session = this.current(project, input.sessionId);
    if (session.state.phase !== "ready" || !session.bridge) return null;
    if (session.pendingFrames >= 2) throw new Error("Too many pending device frames.");
    session.demand = Date.now();
    if (!session.stopCapture) {
      session.stopCapture = session.bridge.capture(
        (frame) => {
          if (project.session !== session || frame.data.length > 2 * 1024 * 1024) return;
          const previous = session.lastFrame;
          if (
            previous &&
            previous.width === frame.width &&
            previous.height === frame.height &&
            previous.mime === frame.mime &&
            (previous.rotation ?? 0) === (frame.rotation ?? 0) &&
            previous.data.equals(frame.data)
          )
            return;
          session.lastFrame = frame;
          session.frame = {
            ...frame,
            rotation: frame.rotation ?? 0,
            sequence: ++session.sequence,
            data: frame.data.toString("base64"),
          };
          for (const waiter of session.waiters) waiter();
        },
        (message) => {
          if (project.session !== session) return;
          session.state.phase = "error";
          session.state.message = message.slice(0, 1000);
          this.pauseCapture(session);
        },
      );
    }
    if (session.frame && session.frame.sequence > input.after) return session.frame;
    session.pendingFrames++;
    try {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          session.waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 700);
        session.waiters.add(finish);
      });
      return project.session === session && session.frame && session.frame.sequence > input.after
        ? session.frame
        : null;
    } finally {
      session.pendingFrames--;
    }
  }

  async input(input: MobileInput) {
    const project = await this.project(input.projectId);
    const session = this.current(project, input.sessionId);
    if (!session.bridge || session.state.phase !== "ready")
      throw new Error("The device is not connected.");
    if (Date.now() - session.demand > 2500)
      throw new Error("Open the device preview before controlling it.");
    if (session.pendingInputs >= 64) throw new Error("Device input is busy. Try again.");
    session.pendingInputs++;
    const task = session.inputs.then(async () => {
      if (session.lifetime.signal.aborted) return;
      if (input.event.kind === "touch")
        session.touch = input.event.phase === "up" ? undefined : input.event;
      await session.bridge!.input(input.event);
    });
    session.inputs = task
      .catch(() => {})
      .finally(() => {
        session.pendingInputs--;
      });
    await task;
  }

  removeProject(projectId: string) {
    const project = this.projects.get(projectId);
    if (project) this.disconnect(project);
    this.projects.delete(projectId);
  }
  async close() {
    this.closing = true;
    clearInterval(this.maintenance);
    for (const project of this.projects.values()) this.disconnect(project);
    for (const child of this.emulators) child.stop();
    await Promise.allSettled([...this.emulators].map((child) => child.done));
    await this.runtime.close();
    await Promise.allSettled(this.tasks);
    this.projects.clear();
  }
}
