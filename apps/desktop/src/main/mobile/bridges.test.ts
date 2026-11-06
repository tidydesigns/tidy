import { expect, spyOn, test } from "bun:test";
import * as files from "node:fs/promises";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEmulatorEndpoint } from "./bridges";
import { Server, ServerCredentials, type ServerUnaryCall, type sendUnaryData } from "@grpc/grpc-js";
import { MobileRPC } from "./rpc";

const endpoint = "grpc.port=8554\ngrpc.token=dummy-device-token\nport.serial=5554\n";

test("endpoint reads preserve serial and adb matching and reject invalid ports and tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-endpoint-"));
  const path = join(root, "pid_1.ini");
  try {
    await writeFile(path, endpoint);
    expect(await readEmulatorEndpoint(path, "emulator-5554")).toEqual({
      port: 8554,
      token: "dummy-device-token",
    });
    expect(await readEmulatorEndpoint(path, "emulator-5556")).toBeNull();
    await writeFile(path, endpoint.replace("port.serial=5554", "port.adb=5555"));
    expect(await readEmulatorEndpoint(path, "emulator-5554")).toMatchObject({ port: 8554 });
    for (const text of [
      endpoint.replace("8554", "0"),
      endpoint.replace("8554", "65536"),
      endpoint.replace("8554", "8.5"),
      endpoint.replace("dummy-device-token", ""),
      endpoint + "x".repeat(64_000),
    ]) {
      await writeFile(path, text);
      expect(await readEmulatorEndpoint(path, "emulator-5554")).toBeNull();
    }
    expect(await readEmulatorEndpoint(root, "emulator-5554")).toBeNull();
    expect(await readEmulatorEndpoint(join(root, "missing.ini"), "emulator-5554")).toBeNull();
    await writeFile(path, endpoint);
    await symlink(path, join(root, "linked.ini"));
    expect(await readEmulatorEndpoint(join(root, "linked.ini"), "emulator-5554")).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("endpoint validation and contents use the same descriptor when the path is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-endpoint-replace-"));
  const path = join(root, "pid_1.ini"),
    replacement = join(root, "replacement.ini");
  await writeFile(path, endpoint);
  await writeFile(replacement, endpoint.replace("8554", "9999"));
  const originalOpen = files.open;
  const opening = spyOn(files, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === path) await rename(replacement, path);
    return handle;
  });
  try {
    expect(await readEmulatorEndpoint(path, "emulator-5554")).toEqual({
      port: 8554,
      token: "dummy-device-token",
    });
  } finally {
    opening.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!process.getuid)("endpoint ownership is checked against the opened file", async () => {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const root = await mkdtemp(join(tmpdir(), "tidy-endpoint-owner-"));
  const path = join(root, "pid_1.ini");
  await writeFile(path, endpoint);
  const currentUser = spyOn(process, "getuid").mockReturnValue(uid + 1);
  try {
    expect(await readEmulatorEndpoint(path, "emulator-5554")).toBeNull();
  } finally {
    currentUser.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("a validated endpoint retains bearer authentication through the real Android RPC transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-endpoint-rpc-"));
  const server = new Server();
  let authorization: unknown[] = [];
  server.addService(
    {
      sendKey: {
        path: "/android.emulation.control.EmulatorController/sendKey",
        requestStream: false,
        responseStream: false,
        requestSerialize: (value: Buffer) => value,
        requestDeserialize: (value: Buffer) => value,
        responseSerialize: () => Buffer.alloc(0),
        responseDeserialize: () => ({}),
      },
    },
    {
      sendKey(call: ServerUnaryCall<Buffer, object>, respond: sendUnaryData<object>) {
        authorization = call.metadata.get("authorization");
        respond(null, {});
      },
    },
  );
  let rpc: MobileRPC | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, port) =>
        error ? reject(error) : resolve(port),
      );
    });
    const path = join(root, "pid_1.ini");
    await writeFile(path, endpoint.replace("8554", String(port)));
    const discovered = await readEmulatorEndpoint(path, "emulator-5554");
    if (!discovered) throw new Error("The valid endpoint was not discovered.");
    rpc = new MobileRPC(
      `127.0.0.1:${discovered.port}`,
      "android.emulation.control.EmulatorController",
      discovered.token,
    );
    await rpc.ready(AbortSignal.timeout(2000));
    await rpc.unary("sendKey", "Keyboard", "Empty", { text: "Hello" });
    expect(authorization).toEqual(["Bearer dummy-device-token"]);
  } finally {
    rpc?.close();
    server.forceShutdown();
    await rm(root, { recursive: true, force: true });
  }
});
