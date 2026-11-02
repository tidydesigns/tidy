import { createServer } from "node:net";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientDuplexStream, ClientReadableStream } from "@grpc/grpc-js";
import type { MobileDevice, MobileInput } from "../../shared/contracts/mobile";
import { androidTools } from "./discovery";
import { IOSRuntime } from "./runtime";
import { mobileExec, mobileProcess, type MobileProcess } from "./process";
import { MobileRPC, type RPCMessage } from "./rpc";

export type DeviceFrame = {
  data: Buffer;
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
  rotation?: 0 | 90 | 180 | 270;
};
export type DeviceBridge = {
  serial: string;
  capture(frame: (frame: DeviceFrame) => void, error: (message: string) => void): () => void;
  input(event: MobileInput["event"]): Promise<void>;
  home(): Promise<void>;
  back(): Promise<void>;
  rotate(): Promise<void>;
  close(): void;
};

/** gRPC may split a JPEG over several payloads. Never retain an unbounded partial frame. */
export class JPEGFrames {
  private pending = Buffer.alloc(0);
  push(value: Buffer, frame: (data: Buffer) => void) {
    this.pending = Buffer.concat([this.pending, value]);
    if (this.pending.length > 2 * 1024 * 1024) {
      this.pending = Buffer.alloc(0);
      return;
    }
    for (;;) {
      const start = this.pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.pending = this.pending.subarray(Math.max(0, this.pending.length - 1));
        return;
      }
      const end = this.pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        this.pending = this.pending.subarray(start);
        return;
      }
      frame(this.pending.subarray(start, end + 2));
      this.pending = this.pending.subarray(end + 2);
    }
  }
}

const keys: Record<string, number> = {
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 51,
  Quote: 52,
  Backquote: 53,
  Comma: 54,
  Period: 55,
  Slash: 56,
  Delete: 76,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
};
export function usbKey(code: string) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 65 + 4;
  if (/^Digit[1-9]$/.test(code)) return Number(code.at(-1)) + 29;
  if (code === "Digit0") return 39;
  return keys[code];
}

export async function connectIOS({
  device,
  runtime,
  signal,
  progress,
}: {
  device: MobileDevice;
  runtime: IOSRuntime;
  signal: AbortSignal;
  progress(message: string): void;
}): Promise<DeviceBridge> {
  const executable = await runtime.get(progress);
  signal.throwIfAborted();
  if (device.state !== "running") {
    progress(`Starting ${device.name}…`);
    await mobileExec("/usr/bin/xcrun", ["simctl", "boot", device.id], { signal, timeout: 90_000 });
  }
  await mobileExec("/usr/bin/xcrun", ["simctl", "bootstatus", device.id, "-b"], {
    signal,
    timeout: 180_000,
  });
  // Darwin's Unix socket path limit is 104 bytes; the normal host scratch path is longer.
  const directory = await mkdtemp("/tmp/tidy-ios-");
  const socket = join(directory, "companion.sock");
  const child = mobileProcess(
    executable,
    [
      "--udid",
      device.id,
      "--grpc-domain-sock",
      socket,
      "--log-level",
      "info",
      "--terminate-offline",
      "1",
    ],
    { signal, timeout: 24 * 60 * 60 * 1000 },
  );
  child.process.once("close", () => {
    void rm(directory, { recursive: true, force: true }).catch(() => {});
  });
  const rpc = new MobileRPC(`unix:${socket}`, "idb.CompanionService");
  let hid: ClientDuplexStream<object, RPCMessage> | undefined;
  let stream: ClientDuplexStream<object, RPCMessage> | undefined;
  let orientation = 0;
  let inputFailure: Error | undefined;
  let width = 0,
    height = 0;
  try {
    progress("Connecting device display…");
    await rpc.ready(signal);
    const description = await rpc.unary("describe", "Empty", "Description", {});
    const dimensions = description.targetDescription?.screenDimensions;
    width = Number(
      dimensions?.widthPoints || (dimensions?.width ?? 0) / (dimensions?.density ?? 1),
    );
    height = Number(
      dimensions?.heightPoints || (dimensions?.height ?? 0) / (dimensions?.density ?? 1),
    );
    if (!(width > 0 && height > 0 && width < 10000 && height < 10000))
      throw new Error("The simulator did not report its display dimensions.");
    const current = await rpc
      .unary("get_orientation", "Empty", "Orientation", {})
      .catch(() => null);
    if (current)
      orientation =
        current.orientation === 3
          ? 2
          : current.orientation === 4
            ? 3
            : current.orientation === 2
              ? 1
              : 0;
    else {
      // Xcode 26 can set orientation but cannot query the CoreDevice capability.
      await rpc.unary("set_orientation", "Orientation", "Empty", { orientation: 0 });
    }
  } catch (error) {
    rpc.close();
    child.stop();
    throw error;
  }

  const press = async (action: object, direction: number) => {
    if (inputFailure) {
      const error = inputFailure;
      inputFailure = undefined;
      throw error;
    }
    if (!hid) {
      const current = rpc.duplex("hid", "HID", "Empty");
      hid = current;
      current.on("data", () => {});
      current.on("error", (error: Error) => {
        if (hid === current) {
          inputFailure = error;
          hid = undefined;
        }
      });
      current.on("end", () => {
        if (hid === current) hid = undefined;
      });
    }
    if (!hid.write({ press: { action, direction } }))
      await new Promise<void>((resolve, reject) => {
        const current = hid!;
        const cleanup = () => {
          current.off("drain", drain);
          current.off("error", fail);
        };
        const drain = () => {
          cleanup();
          resolve();
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        current.once("drain", drain);
        current.once("error", fail);
      });
  };
  // idb flushes and acknowledges a complete gesture when the client stream ends.
  const finish = async () => {
    const current = hid;
    if (!current) {
      if (inputFailure) throw inputFailure;
      return;
    }
    hid = undefined;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        current.cancel();
        reject(new Error("The simulator did not acknowledge input. Reconnect the device."));
      }, 5000);
      current.once("end", () => {
        clearTimeout(timer);
        resolve();
      });
      current.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      current.end();
    });
  };
  const key = async (keycode: number) => {
    await press({ key: { keycode } }, 0);
    await press({ key: { keycode } }, 1);
  };
  const button = async (value: number) => {
    await press({ button: { button: value } }, 0);
    await press({ button: { button: value } }, 1);
    await finish();
  };
  return {
    serial: device.id,
    capture(frame, error) {
      const parser = new JPEGFrames();
      const capture = rpc.duplex("video_stream", "VideoRequest", "VideoResponse");
      stream = capture;
      capture.on("data", (value) => {
        if (value.payload?.data)
          parser.push(value.payload.data, (data) =>
            frame({
              data,
              mime: "image/jpeg",
              width,
              height,
              rotation:
                orientation === 2 ? 270 : orientation === 3 ? 90 : orientation === 1 ? 180 : 0,
            }),
          );
      });
      capture.on("error", (cause: Error) => {
        if (stream === capture) error(cause.message);
      });
      capture.on("end", () => {
        if (stream === capture) error("The simulator display disconnected. Reconnect the device.");
      });
      capture.write({ start: { fps: 30, format: 2, compressionQuality: 0.7, scaleFactor: 0.5 } });
      return () => {
        if (stream === capture) stream = undefined;
        capture.cancel();
      };
    },
    async input(event) {
      if (event.kind === "touch") {
        const x =
          orientation === 2
            ? 1 - event.y
            : orientation === 3
              ? event.y
              : orientation === 1
                ? 1 - event.x
                : event.x;
        const y =
          orientation === 2
            ? event.x
            : orientation === 3
              ? 1 - event.x
              : orientation === 1
                ? 1 - event.y
                : event.y;
        await press(
          { touch: { point: { x: x * width, y: y * height } } },
          event.phase === "up" ? 1 : 0,
        );
        if (event.phase === "up") await finish();
      } else if (event.kind === "key") {
        const value = usbKey(event.code);
        if (!value) return;
        if (event.shift) await press({ key: { keycode: 225 } }, 0);
        try {
          await key(value);
        } finally {
          if (event.shift) await press({ key: { keycode: 225 } }, 1);
        }
        await finish();
      } else {
        // simctl's pasteboard supports Unicode without a global macOS clipboard mutation.
        const pbcopy = mobileProcess("/usr/bin/xcrun", ["simctl", "pbcopy", device.id], { signal });
        pbcopy.process.stdin.end(event.text);
        await pbcopy.done;
        await press({ key: { keycode: 227 } }, 0);
        try {
          await key(25);
        } finally {
          await press({ key: { keycode: 227 } }, 1);
        }
        await finish();
      }
    },
    home: () => button(1),
    back: () => button(1),
    async rotate() {
      orientation = orientation === 0 ? 2 : 0;
      await rpc.unary("set_orientation", "Orientation", "Empty", { orientation });
    },
    close() {
      stream?.cancel();
      hid?.cancel();
      rpc.close();
      child.stop();
    },
  };
}

export async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a device port.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export function emulatorProperties(text: string) {
  return Object.fromEntries(
    text.split(/\r?\n/).flatMap((line) => {
      const index = line.indexOf("=");
      return index > 0 ? [[line.slice(0, index).trim(), line.slice(index + 1).trim()]] : [];
    }),
  );
}
async function emulatorEndpoint(serial: string) {
  const roots = [
    process.env.XDG_RUNTIME_DIR,
    process.env.ANDROID_EMULATOR_HOME,
    process.env.ANDROID_AVD_HOME,
    tmpdir(),
    join(homedir(), "Library/Caches/TemporaryItems"),
  ].filter((path): path is string => Boolean(path));
  for (const root of roots) {
    for (const directory of [join(root, "avd/running"), join(root, "running")]) {
      for (const file of (await readdir(directory).catch(() => []))
        .filter((file) => /^pid_\d+\.ini$/.test(file))
        .slice(0, 64)) {
        const path = join(directory, file);
        const info = await stat(path).catch(() => null);
        if (!info || info.size > 64_000 || (process.getuid && info.uid !== process.getuid()))
          continue;
        const properties = emulatorProperties(await readFile(path, "utf8"));
        const port = Number(properties["grpc.port"]);
        if (
          properties["port.serial"] !== serial.slice(9) &&
          properties["port.adb"] !== String(Number(serial.slice(9)) + 1)
        )
          continue;
        if (Number.isInteger(port) && port > 0 && port <= 65535 && properties["grpc.token"])
          return { port, token: properties["grpc.token"] };
      }
    }
  }
  return null;
}

export async function connectAndroid({
  device,
  signal,
  progress,
  owned,
}: {
  device: MobileDevice;
  signal: AbortSignal;
  progress(message: string): void;
  owned?(process: MobileProcess): void;
}): Promise<DeviceBridge> {
  const { adb, emulator } = await androidTools();
  if (!adb || !emulator)
    throw new Error("Install Android Studio's SDK Platform-Tools and Android Emulator.");
  const avd = device.id.slice(4);
  const devices = await mobileExec(adb, ["devices"], { signal });
  let serial = "";
  for (const line of devices.split(/\r?\n/)) {
    const match = /^(emulator-\d+)\s+device$/.exec(line.trim());
    if (
      match &&
      (await mobileExec(adb, ["-s", match[1], "emu", "avd", "name"], { signal }))
        .split(/\r?\n/)[0]
        .trim() === avd
    ) {
      serial = match[1];
      break;
    }
  }
  let child: MobileProcess | undefined;
  if (!serial) {
    progress(`Starting ${device.name}…`);
    const grpc = await unusedPort();
    child = mobileProcess(
      emulator,
      ["-avd", avd, "-no-window", "-no-audio", "-grpc", String(grpc), "-grpc-use-token"],
      { timeout: 24 * 60 * 60 * 1000 },
    );
    owned?.(child);
    // A launched emulator is independent of the preview, just like a booted iOS simulator.
    for (let retry = 0; retry < 180 && !serial; retry++) {
      signal.throwIfAborted();
      if (child.process.exitCode !== null) {
        await child.done;
        throw new Error("The Android emulator stopped while starting.");
      }
      const list = await mobileExec(adb, ["devices"], { signal });
      for (const line of list.split(/\r?\n/)) {
        const match = /^(emulator-\d+)\s+device$/.exec(line.trim());
        if (
          match &&
          (
            await mobileExec(adb, ["-s", match[1], "emu", "avd", "name"], { signal }).catch(
              () => "",
            )
          )
            .split(/\r?\n/)[0]
            .trim() === avd
        ) {
          serial = match[1];
          break;
        }
      }
      if (!serial) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!serial) {
      child.stop();
      throw new Error(
        "The Android emulator did not finish starting. Check the virtual device in Android Studio.",
      );
    }
  }
  progress("Waiting for Android to finish starting…");
  for (let retry = 0; retry < 180; retry++) {
    signal.throwIfAborted();
    const booted = await mobileExec(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
      signal,
    }).catch(() => "");
    if (booted.trim() === "1") break;
    if (retry === 179)
      throw new Error("Android did not finish booting. Reconnect the device to retry.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const endpoint = await emulatorEndpoint(serial);
  if (!endpoint)
    throw new Error(
      "This emulator has no authenticated display connection. Close it in Android Studio, then connect here so Tidy can start its preview.",
    );
  const rpc = new MobileRPC(
    `127.0.0.1:${endpoint.port}`,
    "android.emulation.control.EmulatorController",
    endpoint.token,
  );
  try {
    await rpc.ready(signal);
  } catch (error) {
    rpc.close();
    throw error;
  }
  let stream: ClientReadableStream<RPCMessage> | undefined;
  let width = 1080,
    height = 1920;
  let rotated = false;
  const resolution = /Physical size:\s*(\d+)x(\d+)/.exec(
    await mobileExec(adb, ["-s", serial, "shell", "wm", "size"], { signal }),
  );
  if (resolution) {
    width = Number(resolution[1]);
    height = Number(resolution[2]);
  }
  const key = (name: string) =>
    rpc.unary("sendKey", "Keyboard", "Empty", { key: name, eventType: 2 }).then(() => {});
  return {
    serial,
    capture(frame, error) {
      const capture = rpc.stream("streamScreenshot", "ImageFormat", "Image", {
        format: 0,
        width: 720,
        height: 1280,
      });
      stream = capture;
      let lastFrame = 0;
      capture.on("data", (value) => {
        if (
          !value.image?.length ||
          value.image.length > 2 * 1024 * 1024 ||
          Date.now() - lastFrame < 32
        )
          return;
        lastFrame = Date.now();
        const w = value.format?.width || value.width,
          h = value.format?.height || value.height;
        if (w && h && w > 0 && h > 0) {
          if (w > h !== width > height) [width, height] = [height, width];
          frame({ data: value.image, mime: "image/png", width: w, height: h });
        }
      });
      capture.on("error", (cause: Error) => {
        if (stream === capture) error(cause.message);
      });
      capture.on("end", () => {
        if (stream === capture) error("The emulator display disconnected. Reconnect the device.");
      });
      return () => {
        if (stream === capture) stream = undefined;
        capture.cancel();
      };
    },
    async input(event) {
      if (event.kind === "touch")
        await rpc.unary("sendTouch", "Touches", "Empty", {
          touches: [
            {
              x: Math.round(event.x * (width - 1)),
              y: Math.round(event.y * (height - 1)),
              identifier: 0,
              pressure: event.phase === "up" ? 0 : 1024,
            },
          ],
        });
      else if (event.kind === "text")
        await rpc.unary("sendKey", "Keyboard", "Empty", { text: event.text });
      else {
        const value = usbKey(event.code);
        if (value) {
          if (event.shift)
            await rpc.unary("sendKey", "Keyboard", "Empty", {
              codeType: 0,
              keyCode: 225,
              eventType: 0,
            });
          try {
            await rpc.unary("sendKey", "Keyboard", "Empty", {
              codeType: 0,
              keyCode: value,
              eventType: 2,
            });
          } finally {
            if (event.shift)
              await rpc.unary("sendKey", "Keyboard", "Empty", {
                codeType: 0,
                keyCode: 225,
                eventType: 1,
              });
          }
        }
      }
    },
    home: () => key("GoHome"),
    back: () => key("GoBack"),
    async rotate() {
      rotated = !rotated;
      await mobileExec(
        adb,
        ["-s", serial, "shell", "settings", "put", "system", "accelerometer_rotation", "0"],
        { signal },
      );
      await mobileExec(
        adb,
        ["-s", serial, "shell", "settings", "put", "system", "user_rotation", rotated ? "1" : "0"],
        { signal },
      );
    },
    close() {
      stream?.cancel();
      rpc.close();
    },
  };
}
