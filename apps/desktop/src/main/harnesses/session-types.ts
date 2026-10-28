import type { HarnessId } from "../../shared/contracts/desktop";
import type { HarnessSettings } from "../../shared/contracts/harness-settings";
import type { ApprovalDecision } from "../../shared/contracts/permissions";
import type { HarnessUpdate, RunningHarness } from "./harnesses";
import type { SkillInvocation } from "./harness-skills";
import type { HarnessTransport, ProtocolMessage } from "./harness-transport";

export type SessionContext = {
  harness: HarnessId;
  executable: string;
  cwd: string;
  additionalDirectories?: string[];
  sessionId?: string;
  settings?: HarnessSettings;
  superviseParent?: boolean;
};
export type TurnInput = {
  prompt: string;
  skill?: { invocation: SkillInvocation; context: string; prompt: string };
  images?: Array<{ path: string; mimeType: string; data: string }>;
  onUpdate: (update: HarnessUpdate) => void;
};
export type AdapterContext = {
  input: SessionContext;
  transport: HarnessTransport;
  emit(update: HarnessUpdate): void;
  complete(error?: Error): void;
  accepted(): void;
  submitting(): void;
  ask(
    nativeId: unknown,
    title: string,
    reason: string,
    details: unknown,
    choices: ApprovalDecision[],
    result: (decision: ApprovalDecision) => unknown,
    scope?: "turn",
  ): void;
  cancelApproval(nativeId: unknown): void;
  isActive(): boolean;
};
export type HarnessAdapter = {
  initialize(): Promise<void>;
  submit(message: TurnInput): Promise<void>;
  consume(message: ProtocolMessage): void;
  interrupt(): Promise<void>;
  steer?(message: Parameters<NonNullable<RunningHarness["steer"]>>[0]): Promise<boolean>;
};
