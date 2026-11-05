import { expect, test } from "bun:test";
import { harnessUpdateSnoozed } from "./harness-updates";
import type { HarnessUpdateState } from "../../../../shared/contracts/harness-updates";

const entry: HarnessUpdateState = {
  id: "codex",
  status: "available",
  installedVersion: "1.2.3",
  latestVersion: "1.3.0",
  canInstall: true,
};
const day = 24 * 60 * 60_000;
const now = 1_000_000;
const snooze = JSON.stringify({ key: "1.2.3:1.3.0:available", until: now + day });

test("snoozes survive reload for one day and then expire", () => {
  expect(harnessUpdateSnoozed(entry, snooze, now)).toBe(true);
  expect(harnessUpdateSnoozed(entry, snooze, now + day - 1)).toBe(true);
  expect(harnessUpdateSnoozed(entry, snooze, now + day)).toBe(false);
});

test("a different release, installed version or outcome is not hidden by an old snooze", () => {
  expect(harnessUpdateSnoozed({ ...entry, latestVersion: "1.4.0" }, snooze, now)).toBe(false);
  expect(harnessUpdateSnoozed({ ...entry, installedVersion: "1.2.4" }, snooze, now)).toBe(false);
  expect(harnessUpdateSnoozed({ ...entry, status: "error" }, snooze, now)).toBe(false);
});

test("old permanent, corrupt or unbounded dismissals cannot hide releases", () => {
  for (const stored of [
    null,
    "1.3.0",
    "{",
    "null",
    '"string"',
    "false",
    JSON.stringify({ key: "1.2.3:1.3.0:available" }),
    JSON.stringify({ key: "1.2.3:1.3.0:available", until: now + day + 1 }),
  ])
    expect(harnessUpdateSnoozed(entry, stored, now)).toBe(false);
});
