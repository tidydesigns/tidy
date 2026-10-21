import { MCP_NOTICE_VERSION } from "./consent";
import { z } from "zod";
import { readJsonResponse } from "@/lib/http/json-response";

async function choice(response: Response) {
  return readJsonResponse({
    response,
    schema: z.object({
      enabled: z.boolean(),
      signedIn: z.boolean().optional(),
      pending: z.boolean().optional(),
    }),
    message: "Your MCP privacy choice could not be confirmed.",
  });
}
const withdrawalKey = "tidy_mcp_pending_withdrawal";

export function pendingMcpWithdrawal() {
  try {
    return sessionStorage.getItem(withdrawalKey) || undefined;
  } catch {
    return undefined;
  }
}

function rememberWithdrawal(enabled: boolean) {
  const token = enabled ? undefined : crypto.randomUUID();
  try {
    if (token) sessionStorage.setItem(withdrawalKey, token);
    else sessionStorage.removeItem(withdrawalKey);
  } catch {
    // Still attempt the server withdrawal if browser storage is unavailable.
  }
  return token;
}

let writes: Promise<unknown> = Promise.resolve();
let withdrawalWrite: { token: string; task: ReturnType<typeof choice> } | undefined;
export function recordMcpChoice(enabled: boolean) {
  // Persist withdrawal before queuing it: the queue itself cannot survive reload.
  const withdrawal = rememberWithdrawal(enabled);
  // Preserve click order without blocking controls or racing intent cookies.
  const task = writes
    .catch(() => {})
    .then(async () => {
      const result = await choice(
        await fetch("/api/privacy/mcp-analytics", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: !enabled,
          headers: { "Content-Type": "application/json", "x-tidy-privacy": "1" },
          body: JSON.stringify({ enabled, noticeVersion: MCP_NOTICE_VERSION }),
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (!result.enabled && withdrawal && pendingMcpWithdrawal() === withdrawal) {
        try {
          sessionStorage.removeItem(withdrawalKey);
        } catch {}
      }
      return result;
    });
  writes = task;
  if (withdrawal) {
    withdrawalWrite = { token: withdrawal, task };
    const finished = () => {
      if (withdrawalWrite?.task === task) withdrawalWrite = undefined;
    };
    void task.then(finished, finished);
  }
  return task;
}
export async function loadMcpChoice() {
  // Replay an interrupted withdrawal before reading or claiming older consent.
  const withdrawal = pendingMcpWithdrawal();
  if (withdrawal) {
    if (withdrawalWrite?.token === withdrawal) return withdrawalWrite.task;
    return recordMcpChoice(false);
  }
  const current = await choice(
    await fetch("/api/privacy/mcp-analytics", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }),
  );
  if (!current.signedIn || !current.pending) return current;
  return choice(
    await fetch("/api/privacy/mcp-analytics", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-tidy-privacy": "1" },
      body: JSON.stringify({ applyPending: true }),
      signal: AbortSignal.timeout(10_000),
    }),
  );
}
