import type { AccountUsageWindow, HarnessUsage } from "../../../../shared/contracts/harness-usage";

export function remainingPercent(window: AccountUsageWindow) {
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}
export function percentLabel(window: AccountUsageWindow) {
  const left = remainingPercent(window);
  return left > 0 && left < 1 ? "<1% left" : `${Math.floor(left)}% left`;
}
export function appliesToModel(window: AccountUsageWindow, modelId?: string) {
  if (!modelId) return true;
  if (window.models) return window.models.includes(modelId);
  return !window.provider || !modelId.includes("/") || modelId.startsWith(`${window.provider}/`);
}
export function relevantWindow(usage: HarnessUsage | undefined, now: number, modelId?: string) {
  // An elapsed reset is a reason to fetch again, never proof that capacity is restored.
  return usage?.windows
    .filter(
      (window) =>
        appliesToModel(window, modelId) &&
        (window.resetsAt === undefined || window.resetsAt * 1000 > now),
    )
    .reduce<AccountUsageWindow | undefined>(
      (mostUsed, window) =>
        !mostUsed || window.usedPercent > mostUsed.usedPercent ? window : mostUsed,
      undefined,
    );
}
export function untilTime(seconds: number, now: number) {
  const minutes = Math.ceil((seconds * 1000 - now) / 60_000);
  if (minutes <= 0) return "Reset time reached";
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Resets in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `Resets in ${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}
export function localTime(seconds: number) {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
export function planName(harness: string, plan?: string) {
  if (!plan) return undefined;
  const codex: Record<string, string> = {
    plus: "ChatGPT Plus",
    pro: "ChatGPT Pro",
    prolite: "ChatGPT Pro",
    promax: "ChatGPT Pro",
    free: "ChatGPT Free",
    go: "ChatGPT Go",
    team: "ChatGPT Business",
    business: "ChatGPT Business",
    enterprise: "ChatGPT Enterprise",
    edu: "ChatGPT Edu",
  };
  const claude: Record<string, string> = {
    pro: "Claude Pro",
    max: "Claude Max",
    ultra: "Claude Ultra",
    team: "Claude Team",
    enterprise: "Claude Enterprise",
    free: "Claude Free",
  };
  return (
    (harness === "codex" ? codex[plan] : harness === "claude" ? claude[plan] : undefined) ?? plan
  );
}
export const tokenCount = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
export const dollars = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
