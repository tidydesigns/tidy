import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sshFailure } from "./errors";
import { bootstrapScript } from "./bootstrap";

const script = bootstrapScript({ bundle: Buffer.from("fixture"), clientId: randomUUID() });
const preflight = script.slice(0, script.indexOf("\nroot="));
for (const [os, cpu, runtime, hash] of [
  [
    "Linux",
    "x86_64",
    "linux-x64",
    "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
  ],
  [
    "Linux",
    "aarch64",
    "linux-arm64",
    "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
  ],
  [
    "Darwin",
    "x86_64",
    "darwin-x64",
    "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
  ],
  [
    "Darwin",
    "arm64",
    "darwin-arm64",
    "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
  ],
]) {
  test(`remote installer selects the verified ${runtime} runtime`, () => {
    const result = spawnSync("/bin/sh", [], {
      input: `uname() { if [ "$1" = "-s" ]; then echo '${os}'; else echo '${cpu}'; fi; }\n${preflight}\nprintf '%s %s' "$platform-$arch" "$checksum"`,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${runtime} ${hash}`);
  });
}
test("unsupported remote systems fail before any installation changes", () => {
  const result = spawnSync("/bin/sh", [], {
    input: `uname() { echo Windows_NT; }\n${preflight}`,
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("separate installer");
  expect(sshFailure(result.stderr).kind).toBe("setup");
});

test("SSH network failures remain retryable while current and older installer errors block", () => {
  for (const message of ["Connection refused", "Connection timed out", "Network is unreachable"])
    expect(sshFailure(message).kind).toBe("unavailable");
  for (const message of [
    "Automatic setup currently supports macOS and Linux",
    "This operating system needs a separate installer.",
  ])
    expect(sshFailure(message).kind).toBe("setup");
});
