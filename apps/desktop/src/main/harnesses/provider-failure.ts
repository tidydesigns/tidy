import { z } from "zod";
import type { HarnessFailureKind } from "../../shared/contracts/harness-failure";
import { describeHarnessFailure } from "../../shared/models/harness-failure";
import { plainToolText } from "./tool-events";

const codes: Readonly<Record<string, HarnessFailureKind>> = {
  contextwindowexceeded: "context",
  sessionbudgetexceeded: "budget",
  usagelimitexceeded: "rate-limit",
  ratelimitexceeded: "rate-limit",
  flexunavailable: "unavailable",
  serveroverloaded: "unavailable",
  modelnotfound: "model",
  policycapacityunavailable: "unavailable",
  cyberpolicy: "policy",
  biopolicy: "policy",
  misalignmentpolicyviolation: "policy",
  toomanydenials: "permission",
  internalservererror: "unavailable",
  unauthorized: "authentication",
  badrequest: "request",
  threadrollbackfailed: "session",
  sandboxerror: "sandbox",
  activeturnnotsteerable: "busy",
  httpconnectionfailed: "connection",
  responsestreamconnectionfailed: "connection",
  responsestreamdisconnected: "connection",
  responsetoomanyfailedattempts: "connection",
  authenticationfailed: "authentication",
  oauthorgnotallowed: "account",
  accountonhold: "account",
  verificationrequired: "account",
  billingerror: "billing",
  ratelimit: "rate-limit",
  overloaded: "unavailable",
  invalidrequest: "request",
  servererror: "unavailable",
  maxoutputtokens: "output",
  cloudcredentialerror: "authentication",
  errormaxturns: "turn-limit",
  errormaxbudgetusd: "budget",
  errormaxstructuredoutputretries: "output-format",
  blockinglimit: "rate-limit",
  rapidrefillbreaker: "rate-limit",
  prompttoolong: "context",
  imageerror: "attachment",
  malformedtooluseexhausted: "output-format",
  abortedstreaming: "interrupted",
  abortedtools: "interrupted",
  stophookprevented: "configuration",
  hookstopped: "configuration",
  maxturns: "turn-limit",
  budgetexhausted: "budget",
  structuredoutputretryexhausted: "output-format",
  tooldeferredunavailable: "request",
  turnsetupfailed: "harness",
  refusal: "policy",
};

const normalizeCode = (code: string) => code.replace(/[_-]/g, "").toLowerCase();
export function providerFailureKind(message: string, code: string): HarnessFailureKind {
  const normalized = normalizeCode(code);
  const kind = Object.hasOwn(codes, normalized) ? codes[normalized] : undefined;
  const generic = [
    "badrequest",
    "httpconnectionfailed",
    "responsestreamconnectionfailed",
    "responsestreamdisconnected",
    "responsetoomanyfailedattempts",
  ].includes(normalized);
  if (kind && !generic) return kind;
  const inferred = describeHarnessFailure(message).kind;
  return inferred === "unknown" ? (kind ?? "unknown") : inferred;
}

export class HarnessFailureError extends Error {
  readonly kind: HarnessFailureKind;
  constructor(message: string, kind?: HarnessFailureKind) {
    super(message);
    this.kind = kind ?? describeHarnessFailure(message).kind;
  }
}

const codexFailureSchema = z.object({
  message: z.string().optional(),
  codexErrorInfo: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
  additionalDetails: z.string().nullish(),
});
const statusSchema = z.object({ httpStatusCode: z.number().int().min(100).max(599).nullish() });

const httpFailureKinds = new Map<number, HarnessFailureKind>([
  [401, "authentication"],
  [402, "billing"],
  [403, "permission"],
  [408, "timeout"],
  [413, "request-size"],
  [429, "rate-limit"],
  [504, "timeout"],
]);

export function codexFailure(value: unknown): HarnessFailureError {
  const parsed = codexFailureSchema.safeParse(value);
  if (!parsed.success) return new HarnessFailureError("Codex could not complete this turn.");
  const { message, additionalDetails, codexErrorInfo } = parsed.data;
  const detail =
    plainToolText([message, additionalDetails].filter(Boolean).join("\n\n")).slice(0, 4000) ||
    "Codex could not complete this turn.";
  let code = "";
  let status: number | null | undefined;
  if (typeof codexErrorInfo === "string") code = codexErrorInfo;
  else if (codexErrorInfo && Object.keys(codexErrorInfo).length === 1) {
    const entry = Object.entries(codexErrorInfo)[0];
    code = entry[0];
    status = statusSchema.safeParse(entry[1]).data?.httpStatusCode;
  }
  const kind = providerFailureKind(detail, code);
  const statusKind = status
    ? (httpFailureKinds.get(status) ??
      (status >= 500 ? "unavailable" : status >= 400 ? "request" : undefined))
    : undefined;
  return new HarnessFailureError(
    detail,
    ["unknown", "connection", "unavailable", "request"].includes(kind)
      ? (statusKind ?? kind)
      : kind,
  );
}
