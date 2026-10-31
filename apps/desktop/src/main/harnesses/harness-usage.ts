import { version } from "../../../package.json";
import type { HarnessId } from "../../shared/contracts/desktop";
import type { HarnessUsage } from "../../shared/contracts/harness-usage";
import { withHarnessConnection } from "./harness-connection";
import { findHarness } from "./harnesses";
import { parseCodexUsage } from "./usage-protocol";
import { claudeAccountUsage, observedUsage, rememberUsage, scopeUsage } from "./usage-state";
import { readOpenCodeUsage } from "./opencode-usage";

export async function readCodexUsage(
  request: (method: string, params?: unknown) => Promise<unknown>,
  cwd: string,
  retainOnFailure = false,
) {
  const [account, limits] = await Promise.all([
    request("account/read", { refreshToken: false }).catch(() => undefined),
    request("account/rateLimits/read").catch(() => undefined),
  ]);
  if (account !== undefined) scopeUsage("codex", cwd, account);
  const value = parseCodexUsage(limits, account);
  // A transient error must not erase valid last-known allowances.
  const previous = observedUsage("codex", cwd);
  if (value.state === "unknown" && previous?.windows.length) {
    if (retainOnFailure) return previous;
    throw new Error("Couldn't refresh account limits.");
  }
  rememberUsage("codex", cwd, value);
  return value;
}

export async function inspectUsage(
  executable: string,
  harness: HarnessId,
  cwd: string,
): Promise<HarnessUsage> {
  if (harness === "opencode") return readOpenCodeUsage(executable, cwd);
  return withHarnessConnection({ executable, harness, cwd }, async (request) => {
    if (harness === "claude") return claudeAccountUsage(await request("initialize"), cwd);
    await request("initialize", { clientInfo: { name: "tidy_desktop", title: "Tidy", version } });
    return readCodexUsage(request, cwd);
  });
}

/** Coalesce reads; refreshes never discover models or start an inference turn. */
const reads = new Map<string, { until: number; pending: boolean; value: Promise<HarnessUsage> }>();
export function readHarnessUsage(harness: HarnessId, cwd: string, refresh = false) {
  const key = `${harness}:${cwd}`;
  const previous = reads.get(key);
  if (previous && (previous.pending || (!refresh && previous.until > Date.now())))
    return previous.value;
  const value = (async () => {
    const executable = await findHarness(harness);
    if (!executable) throw new Error("Install and sign in to this harness to view account usage.");
    return inspectUsage(executable, harness, cwd);
  })();
  const entry = { until: Date.now() + 60_000, pending: true, value };
  void value
    .finally(() => {
      entry.pending = false;
    })
    .catch(() => {});
  reads.set(key, entry);
  if (reads.size > 64) reads.delete(reads.keys().next().value!);
  void entry.value.catch(() => {
    if (reads.get(key) === entry) reads.delete(key);
  });
  return entry.value;
}
