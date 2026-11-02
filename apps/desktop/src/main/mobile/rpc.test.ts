import { expect, test } from "bun:test";
import {
  Server,
  ServerCredentials,
  type ServiceDefinition,
  type ServerWritableStream,
  type ServerUnaryCall,
  type ServerReadableStream,
  type sendUnaryData,
} from "@grpc/grpc-js";
import protobuf from "protobufjs";
import { MobileRPC } from "./rpc";
import { JPEGFrames } from "./bridges";

test("Android capture and keyboard RPCs use the emulator's field numbers and bearer authentication", async () => {
  const root = protobuf.parse(`syntax="proto3";
    message Request { int32 format=1; uint32 width=3; uint32 height=4; }
    message Image { Request format=1; bytes image=4; }
    message Keyboard { int32 codeType=1; int32 eventType=2; int32 keyCode=3; string key=4; string text=5; }
    message Empty {}
  `).root;
  const encode = (name: string) => (value: object) =>
    Buffer.from(root.lookupType(name).encode(root.lookupType(name).fromObject(value)).finish());
  const decode = (name: string) => (value: Buffer) =>
    root.lookupType(name).toObject(root.lookupType(name).decode(value), { bytes: Buffer });
  const methods: ServiceDefinition = {
    streamScreenshot: {
      path: "/android.emulation.control.EmulatorController/streamScreenshot",
      requestStream: false,
      responseStream: true,
      requestSerialize: encode("Request"),
      requestDeserialize: decode("Request"),
      responseSerialize: encode("Image"),
      responseDeserialize: decode("Image"),
    },
    sendKey: {
      path: "/android.emulation.control.EmulatorController/sendKey",
      requestStream: false,
      responseStream: false,
      requestSerialize: encode("Keyboard"),
      requestDeserialize: decode("Keyboard"),
      responseSerialize: encode("Empty"),
      responseDeserialize: decode("Empty"),
    },
  };
  const server = new Server();
  let requested: unknown, token: unknown, keyboard: unknown;
  server.addService(methods, {
    streamScreenshot(call: ServerWritableStream<object, object>) {
      requested = call.request;
      token = call.metadata.get("authorization");
      call.write({ format: { width: 360, height: 720 }, image: Buffer.from([137, 80, 78, 71]) });
      call.end();
    },
    sendKey(call: ServerUnaryCall<object, object>, respond: sendUnaryData<object>) {
      keyboard = call.request;
      respond(null, {});
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  const rpc = new MobileRPC(
    `127.0.0.1:${port}`,
    "android.emulation.control.EmulatorController",
    "test-token",
  );
  try {
    await rpc.ready(AbortSignal.timeout(2000));
    const stream = rpc.stream("streamScreenshot", "ImageFormat", "Image", {
      width: 720,
      height: 1280,
      format: 0,
    });
    const frames: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (frame) => frames.push(frame));
      stream.once("error", reject);
      stream.once("end", resolve);
    });
    expect(requested).toMatchObject({ width: 720, height: 1280 });
    expect((requested as { format?: number }).format ?? 0).toBe(0);
    expect(token).toEqual(["Bearer test-token"]);
    expect(frames).toEqual([
      { format: { width: 360, height: 720 }, image: Buffer.from([137, 80, 78, 71]) },
    ]);
    await rpc.unary("sendKey", "Keyboard", "Empty", { text: "Hello 👋" });
    expect(keyboard).toEqual({ text: "Hello 👋" });
  } finally {
    rpc.close();
    server.forceShutdown();
  }
});

test("JPEG parser handles split markers and multiple frames without retaining unlimited input", () => {
  const parser = new JPEGFrames();
  const frames: Buffer[] = [];
  const emit = (frame: Buffer) => frames.push(frame);
  parser.push(Buffer.from([3, 4, 255]), emit);
  parser.push(Buffer.from([216, 1, 255]), emit);
  parser.push(Buffer.from([217, 255, 216, 2, 255, 217]), emit);
  expect(frames).toEqual([
    Buffer.from([255, 216, 1, 255, 217]),
    Buffer.from([255, 216, 2, 255, 217]),
  ]);
  parser.push(Buffer.alloc(3 * 1024 * 1024), emit);
  parser.push(Buffer.from([255, 216, 3, 255, 217]), emit);
  expect(frames.at(-1)).toEqual(Buffer.from([255, 216, 3, 255, 217]));
});

test("iOS HID touch coordinates retain their nested message instead of resolving to Android touches", async () => {
  const root = protobuf.parse(`syntax="proto3"; package idb;
    message Point { double x=1; double y=2; }
    message HIDEvent {
      message HIDTouch { Point point=1; }
      message HIDPressAction { HIDTouch touch=1; }
      message HIDPress { HIDPressAction action=1; int32 direction=2; }
      HIDPress press=1;
    }
    message Empty {}
  `).root;
  const type = root.lookupType("idb.HIDEvent");
  const requests: unknown[] = [];
  const server = new Server();
  server.addService(
    {
      hid: {
        path: "/idb.CompanionService/hid",
        requestStream: true,
        responseStream: false,
        requestSerialize: (value: object) =>
          Buffer.from(type.encode(type.fromObject(value)).finish()),
        requestDeserialize: (value: Buffer) => type.toObject(type.decode(value)),
        responseSerialize: () => Buffer.alloc(0),
        responseDeserialize: () => ({}),
      },
    },
    {
      hid(call: ServerReadableStream<object, object>, respond: sendUnaryData<object>) {
        call.on("data", (request) => requests.push(request));
        call.on("end", () => respond(null, {}));
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  const rpc = new MobileRPC(`127.0.0.1:${port}`, "idb.CompanionService");
  try {
    await rpc.ready(AbortSignal.timeout(2000));
    const hid = rpc.duplex("hid", "HID", "Empty");
    const ended = new Promise<void>((resolve, reject) => {
      hid.on("data", () => {});
      hid.once("error", reject);
      hid.once("end", resolve);
    });
    hid.write({ press: { action: { touch: { point: { x: 201, y: 437 } } }, direction: 0 } });
    hid.write({ press: { action: { touch: { point: { x: 201, y: 437 } } }, direction: 1 } });
    hid.end();
    await ended;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      press: { action: { touch: { point: { x: 201, y: 437 } } } },
    });
    expect(requests[1]).toMatchObject({ press: { direction: 1 } });
  } finally {
    rpc.close();
    server.forceShutdown();
  }
});
