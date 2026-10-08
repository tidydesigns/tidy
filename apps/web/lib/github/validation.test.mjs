import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { blankDesignDocument, buildDrawnNode } from "../design/document";
import {
  captureBytes,
  parsePullUrl,
  safePreviewUrl,
  snapshotFrames,
  checkedPull,
} from "./validation";
import { pkceChallenge, seal, unseal, validWebhook } from "./crypto";

test("PR links reject credential-bearing, foreign-host and malformed destinations", () => {
  expect(parsePullUrl("https://github.com/tidydesigns/tidy/pull/12")).toEqual({
    repository: "tidydesigns/tidy",
    number: 12,
  });
  for (const value of [
    "https://github.com.evil.test/a/b/pull/1",
    "https://user:pass@github.com/a/b/pull/1",
    "http://github.com/a/b/pull/1",
    "https://github.com/a/b/issues/1",
    "https://github.com/a/b/pull/0",
  ])
    expect(() => parsePullUrl(value)).toThrow();
  expect(safePreviewUrl("javascript:alert(1)")).toBeNull();
  expect(safePreviewUrl("https://secret@example.com")).toBeNull();
});
test("canonical provider metadata rejects oversized UTF-8 and inconsistent PR destinations", () => {
  const pull = {
    number: 7,
    title: "Valid",
    html_url: "https://github.com/tidydesigns/tidy/pull/7",
    state: "open",
    merged: false,
    head: { sha: "1".repeat(40), ref: "feature" },
    base: { sha: "0".repeat(40), repo: { id: 42, full_name: "tidydesigns/tidy" } },
  };
  expect(checkedPull(pull)).toEqual(pull);
  expect(() => checkedPull({ ...pull, title: "界".repeat(342) })).toThrow("oversized");
  expect(() => checkedPull({ ...pull, head: { ...pull.head, ref: "界".repeat(342) } })).toThrow(
    "oversized",
  );
  expect(() => checkedPull({ ...pull, number: 8 })).toThrow("inconsistent");
  expect(() => checkedPull({ ...pull, html_url: "https://attacker.example/pull/7" })).toThrow();
  expect(() => checkedPull({ ...pull, base: { ...pull.base, sha: "invalid" } })).toThrow("invalid");
});
test("frame snapshots include descendants independent of input order, without mutating live navigation", () => {
  const frame = buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 400, height: 300 });
  const other = { ...frame, id: "other" };
  const child = { ...buildDrawnNode("child", "container", "frame", frame.box), linkTo: "other" };
  const grandchild = buildDrawnNode("label", "text", "child", frame.box);
  const document = { ...blankDesignDocument(), nodes: [grandchild, child, other, frame] };
  const snapshot = snapshotFrames(document, ["frame"]);
  expect(snapshot.nodes.map((node) => node.id)).toEqual(["label", "child", "frame"]);
  expect(snapshot.nodes.find((node) => node.id === "child").linkTo).toBeUndefined();
  expect(document.nodes.find((node) => node.id === "child").linkTo).toBe("other");
  expect(() => snapshotFrames(document, ["child"])).toThrow();
});
test("image validation rejects forged MIME types, invalid base64 and oversized captures", () => {
  expect(() => captureBytes(Buffer.from("<svg></svg>").toString("base64"), "image/png")).toThrow();
  expect(() => captureBytes("%%%", "image/png")).toThrow();
  expect(() =>
    captureBytes(Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"), "image/png"),
  ).toThrow();
});
test("webhook signatures authenticate the exact payload and token encryption binds ciphertext to the user", () => {
  const body = '{"action":"opened"}';
  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  expect(validWebhook(body, signature, "test-secret")).toBe(true);
  expect(validWebhook(body + " ", signature, "test-secret")).toBe(false);
  expect(validWebhook(body, "sha256=bad", "test-secret")).toBe(false);
  expect(validWebhook(body, null, "test-secret")).toBe(false);
  const previous = process.env.VAULT_ENCRYPTION_KEY;
  process.env.VAULT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const sealed = seal("test-token", "alice");
    expect(unseal(sealed, "alice")).toBe("test-token");
    expect(() => unseal(sealed, "bob")).toThrow();
  } finally {
    if (previous) process.env.VAULT_ENCRYPTION_KEY = previous;
    else delete process.env.VAULT_ENCRYPTION_KEY;
  }
  expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});
