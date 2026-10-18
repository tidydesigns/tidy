import { expect, test } from "bun:test";
import {
  claudePermissionMode,
  codexPermissions,
  effectivePermissionMode,
  permissionModes,
  validatePermissionMode,
} from "../shared/permissions";
import { harnessSettingsSchema } from "../shared/harness-settings";
import { validateHarnessSettings } from "./harness-details";

test("Auto is explicit full access; existing threads retain their standard mode", () => {
  expect(effectivePermissionMode("codex")).toBe("default");
  expect(effectivePermissionMode("claude")).toBe("accept-edits");
  expect(codexPermissions("default")).toMatchObject({
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  });
  expect(codexPermissions("read-only")).toMatchObject({
    sandbox: "read-only",
    approvalPolicy: "on-request",
  });
  expect(codexPermissions("auto")).toMatchObject({
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  expect(claudePermissionMode("auto")).toBe("bypassPermissions");
  expect(claudePermissionMode("accept-edits")).toBe("acceptEdits");
  expect(claudePermissionMode("plan")).toBe("plan");
  for (const harness of ["codex", "claude"] as const)
    for (const option of permissionModes[harness])
      expect(validatePermissionMode(harness, option.value)).toBe(option.value);
});
test("permission settings reject unsupported modes without a model lookup or inference", async () => {
  expect(harnessSettingsSchema.safeParse({ permissionMode: "unrestricted" }).success).toBe(false);
  const load = async () => {
    throw new Error("Must not inspect models");
  };
  await validateHarnessSettings("claude", "/project", { permissionMode: "auto" }, load);
  await validateHarnessSettings("codex", "/project", { permissionMode: "read-only" }, load);
  await expect(
    validateHarnessSettings("codex", "/project", { permissionMode: "plan" }, load),
  ).rejects.toThrow("not supported");
  await expect(
    validateHarnessSettings("claude", "/project", { permissionMode: "read-only" }, load),
  ).rejects.toThrow("not supported");
});
