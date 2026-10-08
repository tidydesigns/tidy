import "server-only";
import { AgentError } from "./protocol";

export function agentsEnabled() {
  return process.env.TIDY_AGENTS_ENABLED === "true";
}
export function agentEncryptionKey() {
  const raw = process.env.AGENT_ENCRYPTION_KEY;
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw))
    throw new AgentError("not_configured", "ChatGPT connections are not configured.", 503);
  return Buffer.from(raw, "base64");
}
export function agentModel() {
  const model = process.env.AGENT_MODEL;
  if (!model || model.length > 120)
    throw new AgentError("not_configured", "Agent execution is not configured.", 503);
  return model;
}

// Commercial plan sharing is a separate adapter. Native Codex sign-in is usable
// without configuring it. Do not advertise this path until Tidy receives its
// approved integration contract and an end-to-end plan-backed request is verified.
export function chatgptConfigured() {
  return false;
}
