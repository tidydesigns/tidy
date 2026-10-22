import { version } from "../../package.json";
import { validatePermissionMode } from "../shared/permissions";
import { withHarnessConnection } from "./harness-connection";
import { z } from "zod";
import { findHarness } from "./harnesses";
import type { HarnessId } from "../shared/contracts";
import type { HarnessDetails, HarnessSettings, UsageWindow } from "../shared/harness-settings";

const effort = z.string().max(30);
const codexModels = z.object({
  data: z.array(
    z.object({
      model: z.string().max(200),
      displayName: z.string().max(200),
      description: z.string().optional(),
      isDefault: z.boolean().optional(),
      defaultReasoningEffort: effort.optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: effort })).default([]),
    }),
  ),
  nextCursor: z.string().nullish(),
});
const claudeInit = z.object({
  models: z.array(
    z.object({
      value: z.string().max(200),
      displayName: z.string().max(200),
      description: z.string().optional(),
      supportsEffort: z.boolean().optional(),
      supportedEffortLevels: z.array(effort).optional(),
    }),
  ),
  account: z
    .object({ tokenSource: z.string().optional(), apiKeySource: z.string().optional() })
    .optional(),
});

export async function inspectHarness(
  executable: string,
  harness: HarnessId,
  cwd: string,
): Promise<HarnessDetails> {
  return withHarnessConnection({ executable, harness, cwd }, async (request) => {
    try {
      if (harness === "claude") {
        const result = claudeInit.parse(await request("initialize"));
        const models = result.models.map((model) => ({
          id: model.value,
          name: model.displayName,
          description: model.description,
          efforts: model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? []),
        }));
        return {
          models,
          defaultModel: models.find((model) => model.id === "default")?.id,
          windows: [],
          usageError:
            "Claude Code does not expose live account limits through this connection. Thread token usage is shown below when available.",
          updatedAt: new Date().toISOString(),
          usagePage:
            result.account?.apiKeySource && result.account.apiKeySource !== "none"
              ? "api"
              : "subscription",
        };
      }
      await request("initialize", {
        clientInfo: { name: "tidy_desktop", title: "Tidy", version },
      });
      const models: HarnessDetails["models"] = [];
      let cursor: string | null | undefined;
      let defaultModel: string | undefined, defaultEffort: string | undefined;
      do {
        const page = codexModels.parse(
          await request("model/list", {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          }),
        );
        for (const model of page.data) {
          models.push({
            id: model.model,
            name: model.displayName,
            description: model.description,
            efforts: model.supportedReasoningEfforts.map((item) => item.reasoningEffort),
            defaultEffort: model.defaultReasoningEffort,
          });
          if (model.isDefault) {
            defaultModel = model.model;
            defaultEffort = model.defaultReasoningEffort;
          }
        }
        cursor = page.nextCursor;
      } while (cursor && models.length < 500);
      const config = await request("config/read", { includeLayers: false }).catch(() => null);
      const parsedConfig = z
        .object({
          config: z.object({
            model: z.string().nullish(),
            model_reasoning_effort: z.string().nullish(),
          }),
        })
        .safeParse(config);
      if (parsedConfig.success) {
        defaultModel = parsedConfig.data.config.model ?? defaultModel;
        defaultEffort =
          parsedConfig.data.config.model_reasoning_effort ??
          models.find((model) => model.id === defaultModel)?.defaultEffort;
      }
      let windows: UsageWindow[] = [],
        usageError: string | undefined;
      try {
        const window = z.object({
          usedPercent: z.number().min(0).max(100),
          resetsAt: z.number().nullish(),
          windowDurationMins: z.number().nullish(),
        });
        const limits = z
          .object({
            rateLimits: z.object({ primary: window.nullish(), secondary: window.nullish() }),
          })
          .parse(await request("account/rateLimits/read"));
        windows = [limits.rateLimits.primary, limits.rateLimits.secondary].flatMap((value, i) =>
          value
            ? [
                {
                  name: value.windowDurationMins
                    ? value.windowDurationMins >= 1440
                      ? `${Math.round(value.windowDurationMins / 1440)} day`
                      : value.windowDurationMins >= 60
                        ? `${Math.round(value.windowDurationMins / 60)} hour`
                        : `${value.windowDurationMins} minute`
                    : i === 0
                      ? "Primary"
                      : "Secondary",
                  usedPercent: value.usedPercent,
                  resetsAt: value.resetsAt ?? undefined,
                  windowMinutes: value.windowDurationMins ?? undefined,
                },
              ]
            : [],
        );
      } catch {
        usageError =
          "Account limits are unavailable for this connection. Check the provider usage page.";
      }
      let usagePage: HarnessDetails["usagePage"] = "subscription";
      const account = z
        .object({ account: z.object({ type: z.string() }).nullable() })
        .safeParse(await request("account/read", { refreshToken: false }).catch(() => null));
      if (account.success && account.data.account?.type.toLowerCase() === "apikey")
        usagePage = "api";
      return {
        models,
        defaultModel,
        defaultEffort,
        windows,
        usageError,
        updatedAt: new Date().toISOString(),
        usagePage,
      };
    } catch (cause) {
      if (cause instanceof z.ZodError)
        throw new Error(
          "This harness version did not return a supported model catalog. Update its CLI and retry.",
        );
      throw cause;
    }
  });
}
const cache = new Map<string, { until: number; value: Promise<HarnessDetails> }>();
/** Drop cached model and account details after the underlying CLI changes version. */
export function invalidateHarnessDetails(harness: string) {
  for (const key of cache.keys()) if (key.startsWith(`${harness}:`)) cache.delete(key);
}
/** Coalesce model and account discovery per harness/workspace for one minute unless refreshed. */
export function readHarnessDetails(harness: HarnessId, cwd: string, refresh = false) {
  const key = `${harness}:${cwd}`,
    cached = cache.get(key);
  if (!refresh && cached && cached.until > Date.now()) return cached.value;
  const value = (async () => {
    const executable = await findHarness(harness);
    if (!executable) throw new Error("Install and sign in to this harness first.");
    return inspectHarness(executable, harness, cwd);
  })();
  const entry = { value, until: Date.now() + 60_000 };
  cache.set(key, entry);
  void value.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return value;
}
export async function validateHarnessSettings(
  harness: HarnessId,
  cwd: string,
  settings?: HarnessSettings,
  load = readHarnessDetails,
) {
  validatePermissionMode(harness, settings?.permissionMode);
  if (!settings?.model && !settings?.effort) return;
  const details = await load(harness, cwd);
  const model = details.models.find(
    (model) => model.id === (settings.model ?? details.defaultModel),
  );
  if (settings.model && !model) throw new Error("Choose a model offered by the connected harness.");
  if (settings.effort && !model?.efforts.includes(settings.effort))
    throw new Error("This model does not offer that effort level.");
}
