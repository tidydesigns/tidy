export function describeHarnessFailure(message: string) {
  if (
    /cybersecurity risk|daybreak|content.?policy|content.?filter|safety.{0,30}(block|flag)|flagged for|request.{0,20}(blocked|refused)/i.test(
      message,
    )
  )
    return {
      kind: "policy",
      title: "Request blocked",
      guidance:
        "The provider’s safety checks blocked this request. Review and rephrase your message before trying again.",
      daybreak: /daybreak/i.test(message),
    } as const;
  if (
    /quota|insufficient.?credit|out of credits|credit balance|billing|spending.?limit|budget|payment/i.test(
      message,
    )
  )
    return {
      kind: "billing",
      title: "Usage limit reached",
      guidance: "Check your provider’s balance or usage allowance before sending another message.",
    } as const;
  if (
    /session (not found|expired|no longer exists)|unknown session|no conversation found|no rollout found/i.test(
      message,
    )
  )
    return {
      kind: "session",
      title: "Session unavailable",
      guidance:
        "The provider could not resume this session. Start a new thread with a summary of where you left off.",
    } as const;
  if (
    /context.{0,25}(window|length|limit|exceed|full)|too many tokens|prompt.{0,15}(long|large)|request too large|\b413\b/i.test(
      message,
    )
  )
    return {
      kind: "context",
      title: "Conversation is too long",
      guidance:
        "Start a new thread with a shorter summary, or reduce the size of your message and attachments.",
    } as const;
  if (
    /rate.?limit|too many requests|\b429\b|hit your limit|usage.?limit|limit.{0,20}(reached|exceeded)/i.test(
      message,
    )
  )
    return {
      kind: "rate-limit",
      title: "Too many requests",
      guidance:
        "Your provider is limiting requests. Wait for the limit to reset, then send your message again.",
    } as const;
  if (
    /unauthori[sz]ed|unauthenticated|authentication|not.{0,10}(logged|signed).?in|log.?in|sign.?in|api.?key|token.{0,15}(expired|invalid)|\b401\b/i.test(
      message,
    )
  )
    return {
      kind: "authentication",
      title: "Sign in again",
      guidance:
        "Your harness could not authenticate. Reconnect your provider account in Settings, then try again.",
    } as const;
  if (
    /model.{0,40}(not found|not available|unavailable|not supported|does not exist)|do not have access.{0,20}model/i.test(
      message,
    )
  )
    return {
      kind: "model",
      title: "Model unavailable",
      guidance: "Choose a model available to your provider account, then send your message again.",
    } as const;
  if (/permission denied|access denied|forbidden|\b403\b|EACCES|EPERM/i.test(message))
    return {
      kind: "permission",
      title: "Access denied",
      guidance: "Check your account and project permissions before trying again.",
    } as const;
  if (/timed? ?out|timeout|deadline exceeded|ETIMEDOUT/i.test(message))
    return {
      kind: "timeout",
      title: "Request timed out",
      guidance:
        "The provider did not finish in time. Check the conversation and any changes already made before sending your message again.",
    } as const;
  if (
    /network|connection|fetch failed|ECONN|ENOTFOUND|offline|socket|disconnected|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE/i.test(
      message,
    )
  )
    return {
      kind: "connection",
      title: "Connection interrupted",
      guidance:
        "Check your connection and the machine running this thread, then send your message again.",
    } as const;
  if (/overloaded|capacity|service unavailable|internal server error|\b50[0234]\b/i.test(message))
    return {
      kind: "unavailable",
      title: "Provider unavailable",
      guidance: "The provider could not complete this turn. Wait a moment, then try again.",
    } as const;
  if (
    /could not start|installation|executable|ENOENT|invalid event|stopped before|crash/i.test(
      message,
    )
  )
    return {
      kind: "harness",
      title: "Harness stopped",
      guidance: "Check that your harness is installed and up to date, then try again.",
    } as const;
  return {
    kind: "unknown",
    title: "Turn couldn’t finish",
    guidance:
      "Review the error details below before trying again. Your conversation is still available.",
  } as const;
}
