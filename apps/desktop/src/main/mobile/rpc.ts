import {
  Client,
  credentials,
  Metadata,
  type ClientDuplexStream,
  type ClientReadableStream,
} from "@grpc/grpc-js";
import protobuf from "protobufjs";

/** Wire-compatible subset of Meta idb's MIT-licensed proto/idb.proto (v1.7.8).
 * https://github.com/meta/idb/blob/v1.7.8/proto/idb.proto
 * Android message numbers follow the Apache-2.0 Android Emulator controller:
 * https://android.googlesource.com/platform/prebuilts/android-emulator/+/master/linux-x86_64/lib/emulator_controller.proto
 * Only the messages used here are declared; unknown fields remain forward compatible.
 */
const root = protobuf.parse(`syntax = "proto3";
message Empty {}
message Payload { bytes data = 2; }
message VideoRequest { message Start { uint64 fps = 2; int32 format = 3; double compression_quality = 4; double scale_factor = 5; } Start start = 1; Empty stop = 2; }
message VideoResponse { bytes log_output = 1; Payload payload = 2; }
message Point { double x = 1; double y = 2; }
message HID { message Touch { Point point = 1; } message Button { int32 button = 1; } message Key { uint64 keycode = 1; }
 message Action { Touch touch = 1; Button button = 2; Key key = 3; }
 message Press { Action action = 1; int32 direction = 2; } Press press = 1;
}
message Dimensions { uint64 width = 1; uint64 height = 2; double density = 3; uint64 width_points = 4; uint64 height_points = 5; }
message Target { Dimensions screen_dimensions = 3; }
message Description { Target target_description = 1; }
message Orientation { int32 orientation = 1; }
message ImageFormat { int32 format = 1; uint32 width = 3; uint32 height = 4; }
message Image { ImageFormat format = 1; uint32 width = 2; uint32 height = 3; bytes image = 4; }
message AndroidTouch { int32 x = 1; int32 y = 2; int32 identifier = 3; int32 pressure = 4; }
message Touches { repeated AndroidTouch touches = 1; }
message Keyboard { int32 codeType = 1; int32 eventType = 2; int32 keyCode = 3; string key = 4; string text = 5; }
`).root;

export type RPCMessage = {
  orientation?: number;
  payload?: { data?: Buffer };
  targetDescription?: {
    screenDimensions?: {
      width?: number;
      height?: number;
      density?: number;
      widthPoints?: number;
      heightPoints?: number;
    };
  };
  image?: Buffer;
  format?: { width?: number; height?: number };
  width?: number;
  height?: number;
};

const encode = (name: string) => (value: object) =>
  Buffer.from(root.lookupType(name).encode(root.lookupType(name).fromObject(value)).finish());
const decode =
  (name: string) =>
  (value: Buffer): RPCMessage =>
    root.lookupType(name).toObject(root.lookupType(name).decode(value), {
      longs: Number,
      bytes: Buffer,
    }) as RPCMessage;

export class MobileRPC {
  private readonly client: Client;
  private readonly metadata = new Metadata();
  constructor(
    address: string,
    private readonly service: string,
    token?: string,
  ) {
    this.client = new Client(address, credentials.createInsecure(), {
      "grpc.max_receive_message_length": 8 * 1024 * 1024,
    });
    if (token) this.metadata.set("authorization", `Bearer ${token}`);
  }
  ready(signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.client.close();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.client.waitForReady(Date.now() + 20_000, (error) => {
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else if (signal.aborted) reject(signal.reason);
        else resolve();
      });
    });
  }
  unary(method: string, request: string, response: string, value: object): Promise<RPCMessage> {
    return new Promise((resolve, reject) => {
      this.client.makeUnaryRequest(
        `/${this.service}/${method}`,
        encode(request),
        decode(response),
        value,
        this.metadata,
        { deadline: Date.now() + 15_000 },
        (error, result) => (error ? reject(error) : resolve(result!)),
      );
    });
  }
  duplex(
    method: string,
    request: string,
    response: string,
  ): ClientDuplexStream<object, RPCMessage> {
    return this.client.makeBidiStreamRequest(
      `/${this.service}/${method}`,
      encode(request),
      decode(response),
      this.metadata,
    );
  }
  stream(
    method: string,
    request: string,
    response: string,
    value: object,
  ): ClientReadableStream<RPCMessage> {
    return this.client.makeServerStreamRequest(
      `/${this.service}/${method}`,
      encode(request),
      decode(response),
      value,
      this.metadata,
    );
  }
  close() {
    this.client.close();
  }
}
