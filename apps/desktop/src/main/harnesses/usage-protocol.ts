import { z } from "zod";
import type { HarnessUsage, AccountUsageWindow } from "../../shared/contracts/harness-usage";

const label = z.string().trim().min(1).max(200);
const timestamp = z.number().finite().nonnegative().max(8_640_000_000_000);
const nativeWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  resetsAt: timestamp.nullish(),
  windowDurationMins: z.number().positive().nullish(),
});
const nativeBucket = z.object({
  limitId: label.nullish(),
  limitName: label.nullish(),
  primary: nativeWindow.nullish(),
  secondary: nativeWindow.nullish(),
  planType: label.nullish(),
  rateLimitReachedType: label.nullish(),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().max(100).nullish(),
    })
    .nullish(),
});
const codexLimits = z.object({
  ordinaryUsageAllowed: z.boolean().nullish(),
  rateLimits: nativeBucket,
  rateLimitsByLimitId: z.record(z.string(), nativeBucket).nullish(),
  rateLimitResetCredits: z
    .object({
      availableCount: z.number().int().nonnegative(),
      credits: z
        .array(
          z.object({
            id: z.string().max(300),
            title: label.nullish(),
            expiresAt: timestamp.nullish(),
          }),
        )
        .max(100)
        .nullish(),
    })
    .nullish(),
});
export function windowName(minutes?: number | null, index = 0) {
  if (!minutes) return index === 0 ? "Current limit" : "Additional limit";
  if (minutes === 10080) return "Weekly limit";
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}-day limit`;
  if (minutes >= 60) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

/** Parse only public usage fields; auth material and account identifiers never leave the host. */
export function parseCodexUsage(limits: unknown, account?: unknown): HarnessUsage {
  const parsed = codexLimits.safeParse(limits);
  const identity = z
    .object({
      account: z
        .object({
          type: z.string(),
          planType: label.nullish(),
          workspaceName: label.nullish(),
        })
        .nullable(),
    })
    .safeParse(account);
  const current = identity.success ? identity.data.account : undefined;
  const apiKey = current?.type.toLowerCase() === "apikey";
  const data = parsed.success ? parsed.data : undefined;
  const byId = data?.rateLimitsByLimitId;
  const buckets =
    byId && Object.keys(byId).length
      ? Object.entries(byId)
      : [["codex", data?.rateLimits] as const];
  const windows: AccountUsageWindow[] = buckets
    .flatMap(([key, bucket]) =>
      [bucket?.primary, bucket?.secondary].flatMap((window, i) =>
        window
          ? [
              {
                id: `${key}:${i}`,
                name: windowName(window.windowDurationMins, i),
                bucket: buckets.length > 1 ? (bucket?.limitName ?? key) : undefined,
                usedPercent: window.usedPercent,
                resetsAt: window.resetsAt ?? undefined,
                windowMinutes: window.windowDurationMins ?? undefined,
              },
            ]
          : [],
      ),
    )
    .slice(0, 100);
  const credit = data?.rateLimits.credits;
  const resets = data?.rateLimitResetCredits;
  const plan = current?.planType ?? data?.rateLimits.planType;
  return {
    account:
      current || plan
        ? {
            plan: plan && plan !== "unknown" ? plan : undefined,
            workspace: current?.workspaceName ?? undefined,
            billing: apiKey
              ? "api"
              : current?.type === "chatgpt" || plan
                ? "subscription"
                : "unknown",
          }
        : undefined,
    windows,
    credits: credit ? { ...credit, balance: credit.balance?.trim() || undefined } : undefined,
    resets: resets
      ? {
          availableCount: resets.availableCount,
          items: resets.credits?.map((item) => ({
            id: item.id,
            title: item.title ?? undefined,
            expiresAt: item.expiresAt,
          })),
        }
      : undefined,
    state:
      data?.ordinaryUsageAllowed === false ||
      buckets.some(([, bucket]) => bucket?.rateLimitReachedType)
        ? "limited"
        : windows.some((w) => w.usedPercent >= 90)
          ? "warning"
          : data
            ? "available"
            : "unknown",
    note: !data
      ? apiKey
        ? "API usage is managed in your OpenAI account."
        : "Account limits aren't available from this connection."
      : undefined,
    updatedAt: new Date().toISOString(),
    usagePage: apiKey ? "api" : "subscription",
  };
}

export function parseClaudeAccount(value: unknown): HarnessUsage["account"] {
  const result = z
    .object({
      account: z
        .object({
          subscriptionType: label.optional(),
          organization: label.optional(),
          apiKeySource: z.string().optional(),
          tokenSource: z.string().optional(),
        })
        .optional(),
    })
    .safeParse(value);
  const account = result.success ? result.data.account : undefined;
  if (!account) return undefined;
  const api = Boolean(account.apiKeySource && account.apiKeySource !== "none");
  return {
    plan: account.subscriptionType,
    workspace: account.organization,
    billing: api
      ? "api"
      : account.subscriptionType || account.tokenSource === "oauth"
        ? "subscription"
        : "unknown",
  };
}

/** The documented stream event reports one limit, not a complete five-hour/weekly snapshot. */
export function parseClaudeLimit(
  value: unknown,
): Pick<HarnessUsage, "windows" | "state" | "updatedAt"> | undefined {
  const result = z
    .object({
      type: z.literal("rate_limit_event"),
      rate_limit_info: z.object({
        status: z.enum(["allowed", "allowed_warning", "rejected"]),
        utilization: z.number().min(0).max(1).optional(),
        resetsAt: timestamp.optional(),
        rateLimitType: z.string().optional(),
      }),
    })
    .safeParse(value);
  if (!result.success) return;
  const info = result.data.rate_limit_info;
  const known = info.rateLimitType === "five_hour" || info.rateLimitType === "seven_day";
  return {
    windows:
      info.utilization !== undefined
        ? [
            {
              id: info.rateLimitType ?? "reported",
              name:
                info.rateLimitType === "five_hour"
                  ? "5-hour limit"
                  : info.rateLimitType === "seven_day"
                    ? "Weekly limit"
                    : "Reported limit",
              usedPercent: info.utilization * 100,
              resetsAt: info.resetsAt,
              windowMinutes: known ? (info.rateLimitType === "five_hour" ? 300 : 10080) : undefined,
              limited: info.status === "rejected",
            },
          ]
        : [],
    state:
      info.status === "rejected"
        ? "limited"
        : info.status === "allowed_warning"
          ? "warning"
          : "available",
    updatedAt: new Date().toISOString(),
  };
}

const money = z.number().finite().nonnegative();
const meter = z.object({
  percent: z.number().min(0).max(100),
  limited: z.boolean(),
  resetsAt: z.number().finite().nonnegative().max(8_640_000_000_000_000),
});
const openCodeLimits = z.object({
  workspace: z.object({ name: label.optional() }),
  go: z.object({ rolling: meter, weekly: meter, monthly: meter }).nullish(),
  budgets: z
    .array(
      z.object({
        id: z.string().max(300),
        limit: money,
        spent: money,
        resetsAt: z.number().finite().nonnegative().max(8_640_000_000_000_000),
        shared: z.boolean(),
      }),
    )
    .max(90),
});
export function parseOpenCodeUsage(value: unknown): HarnessUsage {
  const result = openCodeLimits.safeParse(value);
  if (!result.success) throw new Error("OpenCode did not return supported usage details.");
  const data = result.data;
  const windows: AccountUsageWindow[] = data.go
    ? [
        ["rolling", "5-hour allowance", 300],
        ["weekly", "Weekly allowance", 10080],
        ["monthly", "Monthly allowance", undefined],
      ].map(([key, name, minutes]) => {
        const window = data.go![key as keyof typeof data.go];
        return {
          id: `go:${key}`,
          name: String(name),
          usedPercent: window.percent,
          resetsAt: window.resetsAt / 1000,
          windowMinutes: minutes as number | undefined,
          limited: window.limited,
        };
      })
    : [];
  for (const budget of data.budgets)
    windows.push({
      id: budget.id,
      name: budget.shared ? "Shared budget" : "Personal budget",
      bucket: "OpenCode Console",
      usedPercent: budget.limit > 0 ? Math.min(100, (budget.spent / budget.limit) * 100) : 100,
      resetsAt: budget.resetsAt / 1000,
      spentUSD: budget.spent,
      limitUSD: budget.limit,
    });
  return {
    account: {
      plan: data.go ? "OpenCode Go" : undefined,
      workspace: data.workspace.name,
      billing: data.go ? "subscription" : "api",
    },
    windows,
    state: windows.some((w) => w.limited || w.usedPercent >= 100)
      ? "limited"
      : windows.some((w) => w.usedPercent >= 90)
        ? "warning"
        : "available",
    note: "Allowances and budgets apply to OpenCode Console. Other providers bill separately.",
    updatedAt: new Date().toISOString(),
    usagePage: "api",
  };
}
