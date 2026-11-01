import { expect, test } from "bun:test";
import { scheduleAttachmentTransfer } from "./attachment-transfer";

test("large attachment requests are serialized and a failure releases the next request", async () => {
  const api = {};
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: number[] = [];
  const first = scheduleAttachmentTransfer(api, async () => {
    started.push(1);
    await gate;
    throw new Error("Disconnected");
  });
  const recovered = first.catch(() => {});
  const second = scheduleAttachmentTransfer(api, async () => {
    started.push(2);
    return "image";
  });
  await Promise.resolve();
  expect(started).toEqual([1]);
  release();
  await recovered;
  expect(await second).toBe("image");
  expect(started).toEqual([1, 2]);
});

test("a busy attachment host does not block another host", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const busy = scheduleAttachmentTransfer({}, () => gate);
  expect(await scheduleAttachmentTransfer({}, async () => "available")).toBe("available");
  release();
  await busy;
});
