import { z } from "zod";
import type { HarnessId } from "./contracts";

export const permissionModeSchema = z.enum([
  "default",
  "accept-edits",
  "read-only",
  "plan",
  "auto",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const approvalDecisionSchema = z.enum(["allow", "allow-session", "deny"]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalRequest = {
  id: string;
  title: string;
  reason?: string;
  details?: string;
  shortened?: boolean;
  choices: ApprovalDecision[];
  scope?: "turn";
};
const auto = {
  value: "auto" as const,
  label: "Auto — Full access",
  description: "Run commands, edit files and access the network without routine approval prompts.",
};
export const permissionModes = {
  codex: [
    {
      value: "default",
      label: "Project access",
      description: "Work in this project. Ask for access beyond the sandbox.",
    },
    {
      value: "read-only",
      label: "Read only",
      description: "Explore files. Ask before running actions that need more access.",
    },
    auto,
  ],
  claude: [
    {
      value: "default",
      label: "Ask before changes",
      description: "Ask before file edits and commands that need permission.",
    },
    {
      value: "accept-edits",
      label: "Accept edits",
      description: "Allow file edits. Ask before commands that need permission.",
    },
    { value: "plan", label: "Plan", description: "Explore and plan. Ask before making changes." },
    auto,
  ],
} satisfies Record<HarnessId, Array<{ value: PermissionMode; label: string; description: string }>>;
export function effectivePermissionMode(harness: HarnessId, mode?: PermissionMode): PermissionMode {
  return mode ?? (harness === "claude" ? "accept-edits" : "default");
}
export function validatePermissionMode(harness: HarnessId, mode?: PermissionMode) {
  const value = effectivePermissionMode(harness, mode);
  if (!permissionModes[harness].some((option) => option.value === value))
    throw new Error("This permission mode is not supported by this harness.");
  return value;
}
export function codexPermissions(mode: PermissionMode) {
  return {
    approvalPolicy: mode === "auto" ? "never" : "on-request",
    sandbox:
      mode === "auto"
        ? "danger-full-access"
        : mode === "read-only"
          ? "read-only"
          : "workspace-write",
    approvalsReviewer: "user",
  };
}
export function claudePermissionMode(mode: PermissionMode) {
  return mode === "auto" ? "bypassPermissions" : mode === "accept-edits" ? "acceptEdits" : mode;
}
