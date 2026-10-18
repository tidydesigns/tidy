import { spawn } from "node:child_process";
import { z } from "zod";
import { findHarness, harnessEnvironment } from "./harnesses";
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

/** A bounded, read-only protocol session. It never sends a user prompt or starts a turn. */
export async function inspectHarness(
  executable: string,
  harness: HarnessId,
  cwd: string,
): Promise<HarnessDetails> {
  const child = spawn(
    executable,
    harness === "codex"
      ? ["app-server", "--listen", "stdio://"]
      : [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "dontAsk",
        ],
    {
      cwd,
      env: harnessEnvironment(),
      stdio: "pipe",
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let serial = 0,
    buffer = "",
    closed = false;
  function stop() {
    if (closed) return;
    closed = true;
    child.stdin.destroy();
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill();
    } catch {}
    const force = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, 1000);
    force.unref();
    child.once("close", () => clearTimeout(force));
  }
  const fail = (message: string) => {
    for (const pending of waiting.values()) pending.reject(new Error(message));
    waiting.clear();
    stop();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.on("error", () => fail("Could not start the harness connection."));
  child.on("close", () => fail("The harness closed before returning its capabilities."));
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 4_000_000) {
      fail("Harness capabilities exceeded the response limit.");
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (harness === "codex" && value.id !== undefined) {
          const pending = waiting.get(String(value.id));
          if (!pending) continue;
          waiting.delete(String(value.id));
          if (value.error)
            pending.reject(new Error("The installed Codex could not provide this information."));
          else pending.resolve(value.result);
        } else if (harness === "claude" && value.type === "control_response") {
          const response = value.response,
            pending = waiting.get(response?.request_id);
          if (!pending) continue;
          waiting.delete(response.request_id);
          if (response.subtype === "error")
            pending.reject(
              new Error("The installed Claude Code could not provide this information."),
            );
          else pending.resolve(response.response);
        } else if (harness === "claude" && value.type === "control_request") {
          // Metadata discovery cannot approve tools or execute agent work.
          child.stdin.write(
            JSON.stringify({
              type: "control_response",
              response: {
                subtype: "error",
                request_id: value.request_id,
                error: "No tools are allowed during capability discovery.",
              },
            }) + "\n",
          );
        }
      } catch {
        fail("The harness returned invalid capability data.");
        return;
      }
    }
  });
  function request(method: string, params?: unknown): Promise<unknown> {
    const id = String(++serial);
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify(
          harness === "codex"
            ? { id: serial, method, ...(params === undefined ? {} : { params }) }
            : { type: "control_request", request_id: id, request: { subtype: method } },
        ) + "\n",
      );
    });
  }
  const timer = setTimeout(
    () => fail("The harness connection timed out. Retry after checking its CLI sign-in."),
    15_000,
  );
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
      clientInfo: { name: "tidy_desktop", title: "Tidy", version: "0.1.0" },
    });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
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
      defaultEffort = parsedConfig.data.config.model_reasoning_effort ?? defaultEffort;
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
    if (account.success && account.data.account?.type.toLowerCase() === "apikey") usagePage = "api";
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
  } finally {
    clearTimeout(timer);
    stop();
  }
}
const cache = new Map<string, { until: number; value: Promise<HarnessDetails> }>();
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
  if (!settings?.model && !settings?.effort) return;
  const details = await load(harness, cwd);
  const model = details.models.find(
    (model) => model.id === (settings.model ?? details.defaultModel),
  );
  if (settings.model && !model) throw new Error("Choose a model offered by the connected harness.");
  if (settings.effort && !model?.efforts.includes(settings.effort))
    throw new Error("This model does not offer that effort level.");
}
