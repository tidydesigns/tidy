import { z } from "zod";
import type { HarnessId } from "./desktop";

export const permissionModeSchema = z.enum([
  "default",
  "accept-edits",
  "read-only",
  "plan",
  "auto",
  "provider-auto",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const approvalDecisionSchema = z.enum(["allow", "allow-session", "deny"]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export const approvalRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  reason: z.string().optional(),
  details: z.string().optional(),
  shortened: z.boolean().optional(),
  choices: z.array(approvalDecisionSchema),
  scope: z.literal("turn").optional(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
// Keep the stored "auto" value for existing Full access threads.
const fullAccess = {
  value: "auto" as const,
  label: "Full access",
  description: "Work without routine approval prompts.",
};
const providerAuto = {
  value: "provider-auto" as const,
  label: "Auto",
  description: "Let the provider review actions using its own permission handling.",
};
export const permissionModes = {
  codex: [
    {
      value: "default",
      label: "Project access",
      description: "Edit project files. Ask for extra access.",
    },
    {
      value: "read-only",
      label: "Read only",
      description: "Read files. Ask before making changes.",
    },
    providerAuto,
    fullAccess,
  ],
  opencode: [
    {
      value: "default",
      label: "Project access",
      description: "Review tools before they run.",
    },
    providerAuto,
    fullAccess,
  ],
  claude: [
    {
      value: "default",
      label: "Project access",
      description: "Ask when edits or commands need approval.",
    },
    {
      value: "accept-edits",
      label: "Accept edits",
      description: "Ask when commands need approval.",
    },
    { value: "plan", label: "Plan", description: "Read files and plan. Ask before changes." },
    providerAuto,
    fullAccess,
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
    approvalsReviewer: mode === "provider-auto" ? "auto_review" : "user",
  };
}
export function claudePermissionMode(mode: PermissionMode) {
  return mode === "auto"
    ? "bypassPermissions"
    : mode === "provider-auto"
      ? "auto"
      : mode === "accept-edits"
        ? "acceptEdits"
        : mode;
}
