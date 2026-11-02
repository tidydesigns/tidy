import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  MobileBuildScope,
  MobileDevice,
  MobileInput,
  MobileState,
  MobileTarget,
} from "../../shared/contracts/mobile";
import { MobileService } from "./mobile-service";
import type { DeviceBridge, DeviceFrame } from "./bridges";

const services: MobileService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function fixture(
  options: {
    delayedConnection?: boolean;
    delayedBuild?: boolean;
    targetRoot?: (scope: MobileBuildScope) => Promise<string>;
  } = {},
) {
  const projectId = randomUUID();
  const device: MobileDevice = {
    id: "test-device",
    platform: "android",
    name: "Pixel",
    runtime: "Android",
    state: "running",
  };
  const target: MobileTarget = {
    id: "gradle:.",
    name: "App",
    kind: "gradle",
    directory: ".",
    platforms: ["android"],
  };
  let allowed = true,
    closed = 0,
    captures = 0,
    paused = 0,
    appStops = 0;
  const inputs: MobileInput["event"][] = [];
  const runRoots: string[] = [];
  let emitted = 0;
  let emit: ((frame: DeviceFrame) => void) | undefined;
  const bridge: DeviceBridge = {
    serial: "emulator-5554",
    capture(frame) {
      emit = frame;
      captures++;
      return () => {
        paused++;
      };
    },
    input: async (event) => {
      inputs.push(event);
    },
    home: async () => {},
    back: async () => {},
    rotate: async () => {},
    close() {
      closed++;
    },
  };
  const connection = Promise.withResolvers<DeviceBridge>();
  const build = Promise.withResolvers<void>();
  const service = new MobileService(
    async () => {
      if (!allowed) throw new Error("Project access revoked.");
      return "/project";
    },
    {
      devices: async () => ({
        devices: [device],
        requirements: [
          {
            platform: "android",
            ready: true,
            message: "Ready",
            helpURL: "https://developer.android.com",
          },
        ],
      }),
      targets: async () => [target],
      ios: async () => bridge,
      android: async () => (options.delayedConnection ? connection.promise : bridge),
      run: async (input) => {
        runRoots.push(input.root);
        input.output("Building…\n");
        if (options.delayedBuild) await build.promise;
        input.running();
        return {
          stop() {
            appStops++;
          },
          reload: async () => {},
        };
      },
    },
    options.targetRoot,
  );
  services.push(service);
  const state = await service.command({ kind: "connect", projectId, deviceId: device.id });
  await tick();
  const sessionId = state.session!.id;
  return {
    service,
    projectId,
    sessionId,
    device,
    target,
    connection,
    build,
    inputs,
    runRoots,
    revoke() {
      allowed = false;
    },
    emit(frame: Partial<DeviceFrame> = {}) {
      emit?.({
        data: Buffer.from([++emitted, 2, 3]),
        mime: "image/png",
        width: 100,
        height: 200,
        ...frame,
      });
    },
    stats: () => ({ closed, captures, paused, appStops }),
    state: () => service.state({ projectId }),
  };
}

test("frames retain only the latest image and cannot be read after access revocation", async () => {
  const f = await fixture();
  const waiting = f.service.frame({ projectId: f.projectId, sessionId: f.sessionId, after: 0 });
  await tick();
  f.emit();
  expect(await waiting).toMatchObject({ sequence: 1, data: "AQID" });
  f.emit();
  f.emit();
  expect(
    await f.service.frame({ projectId: f.projectId, sessionId: f.sessionId, after: 1 }),
  ).toMatchObject({ sequence: 3 });
  expect(f.stats().captures).toBe(1);
  f.revoke();
  await expect(
    f.service.frame({ projectId: f.projectId, sessionId: f.sessionId, after: 0 }),
  ).rejects.toThrow("revoked");
});

test("disconnect invalidates stale input and releases a pressed touch", async () => {
  const f = await fixture();
  const frame = f.service.frame({ projectId: f.projectId, sessionId: f.sessionId, after: 0 });
  await tick();
  f.emit();
  await frame;
  await f.service.input({
    projectId: f.projectId,
    sessionId: f.sessionId,
    event: { kind: "touch", phase: "down", x: 0.4, y: 0.7 },
  });
  await f.service.command({ kind: "disconnect", projectId: f.projectId, sessionId: f.sessionId });
  expect(f.inputs.at(-1)).toEqual({ kind: "touch", phase: "up", x: 0.4, y: 0.7 });
  expect(f.stats()).toMatchObject({ closed: 1, paused: 1 });
  await expect(
    f.service.input({
      projectId: f.projectId,
      sessionId: f.sessionId,
      event: { kind: "key", code: "KeyA" },
    }),
  ).rejects.toThrow("session ended");
});

test("a connection finishing after disconnect is closed rather than reviving the panel", async () => {
  const f = await fixture({ delayedConnection: true });
  await f.service.command({ kind: "disconnect", projectId: f.projectId, sessionId: f.sessionId });
  f.connection.resolve({
    serial: "late",
    capture: () => () => {},
    input: async () => {},
    home: async () => {},
    back: async () => {},
    rotate: async () => {},
    close() {
      f.inputs.push({ kind: "key", code: "closed" });
    },
  });
  await tick();
  expect((await f.state()).session).toBeNull();
  expect(f.inputs).toEqual([{ kind: "key", code: "closed" }]);
});

test("stopping an unfinished build cannot later mark the app running", async () => {
  const f = await fixture({ delayedBuild: true });
  await f.service.command({
    kind: "run",
    projectId: f.projectId,
    sessionId: f.sessionId,
    targetId: f.target.id,
  });
  expect((await f.state()).session?.run?.phase).toBe("building");
  await f.service.command({ kind: "stop", projectId: f.projectId, sessionId: f.sessionId });
  f.build.resolve();
  await tick();
  expect((await f.state()).session?.run?.phase).toBe("stopped");
  expect(f.stats().appStops).toBe(1);
});

test("the same emulator cannot be controlled from two projects", async () => {
  const f = await fixture();
  await expect(
    f.service.command({ kind: "connect", projectId: randomUUID(), deviceId: f.device.id }),
  ).rejects.toThrow("another Tidy project");
});

test("rejects a forged build target before invoking project commands", async () => {
  const f = await fixture();
  await f.service.command({
    kind: "run",
    projectId: f.projectId,
    sessionId: f.sessionId,
    targetId: "../../other-app",
  });
  await tick();
  const state: MobileState = await f.state();
  expect(state.session?.run?.phase).toBe("failed");
  expect(state.session?.run?.message).toContain("target moved");
});

test("hidden previews stop capture and release touches while retaining the device session", async () => {
  const f = await fixture();
  const frame = f.service.frame({ projectId: f.projectId, sessionId: f.sessionId, after: 0 });
  await tick();
  f.emit();
  await frame;
  await f.service.input({
    projectId: f.projectId,
    sessionId: f.sessionId,
    event: { kind: "touch", phase: "down", x: 0.4, y: 0.6 },
  });
  await new Promise((resolve) => setTimeout(resolve, 2600));
  expect(f.stats()).toMatchObject({ paused: 1, closed: 0 });
  expect(f.inputs.at(-1)).toMatchObject({ kind: "touch", phase: "up" });
  expect((await f.state()).session?.phase).toBe("ready");
  const resumed = f.service.frame({ projectId: f.projectId, sessionId: f.sessionId, after: 1 });
  await tick();
  f.emit();
  await resumed;
  expect(f.stats().captures).toBe(2);
});

test("unchanged frames do not transfer again, while a rotation with identical bytes does", async () => {
  const f = await fixture();
  const input = { projectId: f.projectId, sessionId: f.sessionId, after: 0 };
  const waiting = f.service.frame(input);
  await tick();
  const data = Buffer.from([9, 8, 7]);
  f.emit({ data });
  expect(await waiting).toMatchObject({ sequence: 1 });
  f.emit({ data: Buffer.from(data) });
  expect(await f.service.frame({ ...input, after: 1 })).toBeNull();
  f.emit({ data, rotation: 90 });
  expect(await f.service.frame({ ...input, after: 1 })).toMatchObject({
    sequence: 2,
    rotation: 90,
  });
});

test("mobile builds use the selected thread worktree without resolving it for every frame", async () => {
  const threadId = randomUUID();
  let resolutions = 0;
  const f = await fixture({
    targetRoot: async (scope) => {
      resolutions++;
      return scope.threadId === threadId ? "/project-worktree" : "/project";
    },
  });
  const scope = { projectId: f.projectId, threadId };
  await f.service.state(scope);
  const before = resolutions;
  await f.service.state(scope);
  expect(resolutions).toBe(before);
  await f.service.command({ ...scope, kind: "run", sessionId: f.sessionId, targetId: f.target.id });
  await tick();
  expect(f.runRoots).toEqual(["/project-worktree"]);
  const afterRun = resolutions;
  const frame = f.service.frame({ projectId: f.projectId, sessionId: f.sessionId, after: 0 });
  await tick();
  f.emit();
  await frame;
  await f.service.input({
    projectId: f.projectId,
    sessionId: f.sessionId,
    event: { kind: "key", code: "KeyA" },
  });
  expect(resolutions).toBe(afterRun);
});
