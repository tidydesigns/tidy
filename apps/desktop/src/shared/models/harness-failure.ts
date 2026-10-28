import type { HarnessFailureKind } from "../contracts/harness-failure";

const descriptions = {
  policy: {
    title: "Request blocked",
    guidance:
      "The provider’s safety checks blocked this request. Review and rephrase your message before trying again.",
  },
  billing: {
    title: "Usage limit reached",
    guidance: "Check your provider’s balance or usage allowance before sending another message.",
  },
  session: {
    title: "Session unavailable",
    guidance:
      "The provider could not resume this session. Start a new thread with a summary of where you left off.",
  },
  context: {
    title: "Conversation is too long",
    guidance:
      "Start a new thread with a shorter summary, or reduce the size of your message and attachments.",
  },
  "rate-limit": {
    title: "Too many requests",
    guidance:
      "Your provider is limiting requests. Wait for the limit to reset, then send your message again.",
  },
  authentication: {
    title: "Sign in again",
    guidance:
      "Check your provider sign-in and credentials on the machine running this thread, then reconnect in Settings.",
  },
  model: {
    title: "Model unavailable",
    guidance: "Choose a model available to your provider account, then send your message again.",
  },
  permission: {
    title: "Access denied",
    guidance: "Check your account and project permissions before trying again.",
  },
  timeout: {
    title: "Request timed out",
    guidance:
      "The provider did not finish in time. Check the conversation and any changes already made before sending your message again.",
  },
  connection: {
    title: "Connection interrupted",
    guidance:
      "Check your connection and the machine running this thread, then send your message again.",
  },
  unavailable: {
    title: "Provider unavailable",
    guidance: "The provider could not complete this turn. Wait a moment, then try again.",
  },
  harness: {
    title: "Harness stopped",
    guidance: "Check that your harness is installed and up to date, then try again.",
  },
  unknown: {
    title: "Turn couldn’t finish",
    guidance:
      "Review the error details below before trying again. Your conversation is still available.",
  },
  budget: {
    title: "Run budget reached",
    guidance:
      "This run reached its configured budget. Review the work already completed and the harness budget before continuing.",
  },
  "turn-limit": {
    title: "Run limit reached",
    guidance:
      "The harness reached its turn or message limit. Review the work so far, then continue in a new thread or adjust the harness limit.",
  },
  output: {
    title: "Response limit reached",
    guidance:
      "The provider could not finish within its output limit. Ask for a shorter response or continue from where it stopped.",
  },
  "output-format": {
    title: "Response format failed",
    guidance:
      "The provider could not produce the required response format. Review the output requirements before trying again.",
  },
  attachment: {
    title: "Attachment couldn’t be read",
    guidance:
      "Check the attachment’s format, size, and availability. Remove or replace it before trying again.",
  },
  request: {
    title: "Request couldn’t be accepted",
    guidance:
      "Review the message and selected model’s supported options before trying again. The error details may identify an unsupported setting.",
  },
  "request-size": {
    title: "Request is too large",
    guidance: "Reduce the size of your message and attachments before sending it again.",
  },
  sandbox: {
    title: "Sandbox unavailable",
    guidance:
      "Check the harness sandbox setup on the machine running this thread. Keep the requested security restrictions in place while resolving the error.",
  },
  account: {
    title: "Account needs attention",
    guidance:
      "Check your provider account’s verification, organization access, and account status before trying again.",
  },
  configuration: {
    title: "Harness configuration needs attention",
    guidance:
      "Check the harness settings, hooks, and startup options on the machine running this thread.",
  },
  storage: {
    title: "Changes couldn’t be stored",
    guidance:
      "Check available disk space and write access on the machine running this thread. Keep this conversation open until your work is secured.",
  },
  workspace: {
    title: "Project unavailable",
    guidance:
      "Check that the project folder still exists and is accessible on the machine running this thread.",
  },
  busy: {
    title: "A turn is already running",
    guidance: "Wait for the active turn to finish or stop it before sending another message.",
  },
  interrupted: {
    title: "Turn interrupted",
    guidance: "Review the conversation and any changes already made before continuing.",
  },
} satisfies Record<HarnessFailureKind, { title: string; guidance: string }>;

const rules: ReadonlyArray<readonly [HarnessFailureKind, RegExp]> = [
  [
    "policy",
    /cybersecurity risk|daybreak|content.?policy|content.?filter|safety.{0,30}(block|flag)|flagged for|request.{0,20}(blocked|refused)|model.{0,15}refus|usage polic/i,
  ],
  [
    "storage",
    /ENOSPC|EDQUOT|no space left|disk full|could not be written to disk|read.only file system|EROFS/i,
  ],
  [
    "budget",
    /session.?budget|run.?budget|budget[_ -]exhausted|max[_ -]budget|shared rollout token budget/i,
  ],
  [
    "billing",
    /insufficient.?quota|insufficient.?credit|out of credits|credit balance|billing|spend(?:ing)?.?limit|payment|\b402\b/i,
  ],
  [
    "account",
    /account.{0,15}(hold|suspend|deactivat)|verification[_ -]required|verify your (identity|account)|oauth[_ -]org[_ -]not[_ -]allowed/i,
  ],
  [
    "session",
    /session (not found|expired|no longer exists)|unknown session|no conversation found|no rollout found|no thread with id/i,
  ],
  [
    "context",
    /context.{0,30}(window|length|limit|exceed|full)|too many (input )?tokens|prompt.{0,15}(long|large)|input.{0,10}too long/i,
  ],
  [
    "output-format",
    /structured[_ -]output|malformed[_ -]tool[_ -]use|invalid tool (arguments|input)/i,
  ],
  [
    "output",
    /max[_ -]output[_ -]tokens|output.{0,20}(token limit|too long)|response.{0,15}output limit/i,
  ],
  ["turn-limit", /max[_ -]turns|turn.{0,15}limit|message limit|maximum number of turns/i],
  [
    "attachment",
    /invalid[_ -]image|image[_ -]error|image.{0,30}(decode|invalid|unsupported|too large)|attachment.{0,30}(missing|unsupported|too large)|unsupported.{0,20}(image|media type)/i,
  ],
  ["request-size", /request[_ -](?:is[_ -])?too[_ -]large|\b413\b/i],
  [
    "rate-limit",
    /rate.?limit|too many requests|\b429\b|hit your limit|usage.?limit|quota.{0,15}(exceeded|reached)/i,
  ],
  [
    "authentication",
    /unauthori[sz]ed|unauthenticated|authenticat|not.{0,10}(logged|signed).?in|log.?in|sign.?in|cloud[_ -]credential|(?:missing|invalid|expired|revoked).{0,12}(api.?key|credentials?)|api.?key.{0,12}(missing|invalid|expired|revoked)|token.{0,20}(expired|invalid|revoked)|\b401\b/i,
  ],
  [
    "model",
    /model.{0,40}(not.found|not.available|unavailable|not.supported|does.not.exist|deprecated)|(?:unknown|invalid|unsupported) model|(?:do not have access|no access).{0,20}model/i,
  ],
  ["sandbox", /sandbox|landlock|seccomp/i],

  [
    "workspace",
    /working directory.{0,20}(missing|gone|not found)|project folder.{0,15}(missing|not found)|cwd.{0,15}(ENOENT|not found)/i,
  ],
  [
    "permission",
    /permission[_ -]error|permission denied|access denied|forbidden|\b403\b|EACCES|EPERM/i,
  ],
  ["timeout", /timed? ?out|timeout|deadline exceeded|ETIMEDOUT|\b408\b|\b504\b/i],
  [
    "connection",
    /network|connection|fetch failed|ECONN|ENOTFOUND|offline|socket|disconnected|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
  ],
  [
    "unavailable",
    /overloaded|capacity|service unavailable|server[_ -]error|api_error|bad gateway|\b50[0-3]\b|\b529\b/i,
  ],
  ["busy", /turn.{0,25}(already running|still active|already active)|already.{0,10}active turn/i],
  ["interrupted", /turn.{0,15}(interrupted|aborted)|aborted[_ -](streaming|tools)/i],
  [
    "configuration",
    /invalid.{0,15}(config|configuration)|config.{0,15}(invalid|parse error)|unrecognized (argument|option)|unknown (argument|option)|hook.{0,15}(failed|blocked|stopped)/i,
  ],
  [
    "request",
    /not[_ -]found[_ -]error|invalid[_ -]request|bad request|unsupported.{0,15}(parameter|option)|\b400\b|\b404\b|\b422\b/i,
  ],
  [
    "harness",
    /could not start|installation|executable|ENOENT|invalid event|stopped before|crash|output exceeded the message limit/i,
  ],
];

export function describeHarnessFailure(message: string, knownKind?: HarnessFailureKind) {
  const kind =
    knownKind && knownKind !== "unknown"
      ? knownKind
      : (rules.find(([, pattern]) => pattern.test(message))?.[0] ?? "unknown");
  return { kind, ...descriptions[kind], daybreak: kind === "policy" && /daybreak/i.test(message) };
}
