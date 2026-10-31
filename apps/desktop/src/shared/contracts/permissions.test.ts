import { expect, test } from "bun:test";
import {
  claudePermissionMode,
  codexPermissions,
  effectivePermissionMode,
  permissionModes,
  validatePermissionMode,
} from "./permissions";
import { harnessSettingsSchema } from "./harness-settings";
import { validateHarnessSettings } from "../../main/harnesses/harness-details";

test("native Auto stays reviewed and distinct from Full access; legacy selections keep their meaning", () => {
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
  expect(claudePermissionMode("provider-auto")).toBe("auto");
  expect(codexPermissions("provider-auto")).toEqual({
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  });
  for (const harness of ["codex", "claude", "opencode"] as const) {
    expect(permissionModes[harness].find((option) => option.value === "auto")?.label).toBe(
      "Full access",
    );
    expect(permissionModes[harness].find((option) => option.value === "provider-auto")?.label).toBe(
      "Auto",
    );
  }
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
