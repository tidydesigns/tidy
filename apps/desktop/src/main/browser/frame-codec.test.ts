import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { decodeBrowserFrame, encodeBrowserFrame } from "./frame-codec";
import { browserVideoPacket } from "../../shared/browser-video";

test("JPEG frames retain the existing binary envelope; H.264 frames round trip with a version marker", () => {
  const frame = {
    kind: "frame" as const,
    tabId: randomUUID(),
    viewId: randomUUID(),
    frameId: 1350000000000,
    data: Buffer.from([255, 216, 255, 217]),
  };
  const jpeg = encodeBrowserFrame(frame);
  assert.equal(jpeg.length, 84);
  assert.equal(jpeg.subarray(0, 36).toString(), frame.tabId);
  assert.deepEqual(decodeBrowserFrame(jpeg), frame);
  const video = { ...frame, codec: "h264" as const };
  assert.deepEqual(decodeBrowserFrame(encodeBrowserFrame(video)), video);
  for (const length of [0, 3, 4, 79, 80, 83])
    assert.equal(decodeBrowserFrame(encodeBrowserFrame(video).subarray(0, length)), null);
  const invalid = Buffer.from(jpeg);
  invalid.writeDoubleBE(NaN, 72);
  assert.equal(decodeBrowserFrame(invalid), null);
});

test("video packets require a complete single-stripe header and derive the codec from a bounded SPS", () => {
  const packet = Buffer.alloc(23);
  packet.set([1, 1]);
  packet[11] = packet[12] = 1;
  packet.set([0, 0, 1, 103, 100, 0, 52], 16);
  assert.equal(browserVideoPacket(packet).codec, "avc1.640034");
  assert.equal(browserVideoPacket(packet).key, true);
  const invalidStripe = Buffer.from(packet);
  invalidStripe[11] = 2;
  assert.throws(() => browserVideoPacket(invalidStripe));
  for (const length of [0, 1, 15, 16])
    assert.throws(() => browserVideoPacket(packet.subarray(0, length)));
  assert.equal(browserVideoPacket(packet.subarray(0, 22)).codec, undefined);
});
