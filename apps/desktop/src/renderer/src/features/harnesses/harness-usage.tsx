import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Button } from "@tidy/ui/button";
import { HarnessIcon } from "@tidy/ui/harness-icon";
import { harnessNames } from "../../../../shared/contracts/harness-updates";
import type { DesktopAPI, HarnessId } from "../../../../shared/contracts/desktop";
import type {
  HarnessUsage as Usage,
  AccountUsageWindow,
} from "../../../../shared/contracts/harness-usage";
import type { TokenUsage } from "../../../../shared/contracts/harness-settings";
import { codeFontClassName } from "../../styles/code-ui";
import { usageCache } from "./usage-cache";
import {
  appliesToModel,
  dollars,
  localTime,
  percentLabel,
  planName,
  relevantWindow,
  remainingPercent,
  tokenCount,
  untilTime,
} from "./usage-format";

function UsageWindow({ window, now }: { window: AccountUsageWindow; now: number }) {
  const elapsed = Boolean(window.resetsAt !== undefined && window.resetsAt * 1000 <= now);
  return (
    <div
      className="account-usage-window"
      data-low={(window.usedPercent >= 90 && !elapsed) || undefined}
    >
      <div className="account-usage-line">
        <span>{window.name}</span>
        <span className="account-usage-number">{elapsed ? "Checking…" : percentLabel(window)}</span>
      </div>
      {window.bucket && <div className="account-usage-muted">{window.bucket}</div>}
      <div
        className="account-usage-track"
        role="meter"
        aria-label={`${window.bucket ? `${window.bucket} · ` : ""}${window.name} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPercent(window)}
        aria-valuetext={
          elapsed ? "Reset time reached. Waiting for updated usage." : percentLabel(window)
        }
        data-stale={elapsed || undefined}
      >
        <span style={{ width: `${remainingPercent(window)}%` }} />
      </div>
      <div className="account-usage-line account-usage-muted">
        {window.spentUSD !== undefined && window.limitUSD !== undefined && (
          <span>
            {dollars(window.spentUSD)} of {dollars(window.limitUSD)}
          </span>
        )}
        {window.resetsAt !== undefined && (
          <time
            className="account-usage-reset-time"
            dateTime={new Date(window.resetsAt * 1000).toISOString()}
            aria-label={`${untilTime(window.resetsAt, now)} · ${localTime(window.resetsAt)}`}
            title={localTime(window.resetsAt)}
          >
            <span>{untilTime(window.resetsAt, now)}</span>
            <span>
              {new Date(window.resetsAt * 1000).toLocaleString(undefined, {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </time>
        )}
      </div>
    </div>
  );
}

/** Owns its refresh clock so streaming a conversation doesn't rerender or refetch account usage. */
export const HarnessUsage = memo(function HarnessUsage({
  api,
  projectId,
  harness,
  ready,
  initial,
  tokens,
  activity,
  modelId,
}: {
  api: DesktopAPI;
  projectId: string;
  harness: HarnessId;
  ready: boolean;
  initial?: Usage;
  tokens?: TokenUsage;
  activity?: string;
  modelId?: string;
}) {
  const modelProvider = modelId?.includes("/") ? modelId.split("/")[0] : undefined;
  const providerApplicable =
    harness !== "opencode" ||
    !modelProvider ||
    modelProvider === "opencode" ||
    modelProvider === "opencode-go";
  const cache = useMemo(
    () => usageCache(api, projectId, harness, initial),
    [api, projectId, harness],
  );
  const snapshot = useSyncExternalStore(cache.subscribe, cache.read, cache.read);
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewId = useId();
  const control = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const previewDismissed = useRef(false);
  const closePreview = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [now, setNow] = useState(Date.now);
  const [managementError, setManagementError] = useState(false);
  const previousActivity = useRef(activity);
  useLayoutEffect(() => {
    if (ready && providerApplicable) cache.seed(initial);
  }, [cache, initial, ready, providerApplicable]);
  useEffect(() => {
    const finished = previousActivity.current === "running" && activity !== "running";
    previousActivity.current = activity;
    if (ready && providerApplicable && api.harnessUsage && !document.hidden)
      void cache.refresh(finished);
  }, [cache, ready, activity, api, providerApplicable]);
  useEffect(() => {
    if (!ready) cache.clear();
  }, [cache, ready]);
  useLayoutEffect(() => {
    clearTimeout(closePreview.current);
    setOpen(false);
    setPreviewOpen(false);
    previewDismissed.current = false;
    setManagementError(false);
  }, [cache, modelProvider]);
  useEffect(() => {
    if (!open && !previewOpen) return;
    const refresh = () => {
      if (document.hidden) return;
      setNow(Date.now());
      if (ready && providerApplicable && api.harnessUsage) void cache.refresh();
    };
    refresh();
    const clock = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [open, previewOpen, cache, ready, api, providerApplicable]);
  useEffect(() => () => clearTimeout(closePreview.current), []);
  const showPreview = () => {
    clearTimeout(closePreview.current);
    if (!open && !previewDismissed.current) setPreviewOpen(true);
  };
  const hidePreview = (dismiss = false) => {
    clearTimeout(closePreview.current);
    if (dismiss) previewDismissed.current = true;
    setPreviewOpen(false);
  };
  useLayoutEffect(() => {
    const popup = preview.current;
    if (!previewOpen || open || !popup || !control.current) return;
    popup.showPopover();
    const position = () => {
      const anchor = control.current?.getBoundingClientRect();
      if (!anchor) return;
      const bounds = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8))}px`;
      popup.style.top = `${Math.max(8, anchor.top - bounds.height - 6)}px`;
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(popup);
    window.addEventListener("resize", position);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", position);
      if (popup.matches(":popover-open")) popup.hidePopover();
    };
  }, [previewOpen, open]);
  const usage = ready && providerApplicable ? snapshot.value : undefined;
  const currentTime = Math.max(now, Date.now());
  const nextReset = usage?.windows.reduce<number | undefined>((next, window) => {
    if (!appliesToModel(window, modelId)) return next;
    const at = window.resetsAt === undefined ? undefined : window.resetsAt * 1000;
    return at !== undefined && at > currentTime && (next === undefined || at < next) ? at : next;
  }, undefined);
  useEffect(() => {
    if (nextReset === undefined) return;
    // One deadline keeps a closed trigger current without background polling.
    const deadline = window.setTimeout(
      () => {
        setNow(Date.now());
        if (
          Date.now() >= nextReset &&
          !document.hidden &&
          ready &&
          providerApplicable &&
          api.harnessUsage
        )
          void cache.refresh(true);
      },
      Math.min(2_147_483_647, Math.max(1, nextReset - Date.now())),
    );
    return () => window.clearTimeout(deadline);
  }, [cache, nextReset, now, ready, providerApplicable, api]);
  const visibleWindows = usage?.windows.filter((window) => appliesToModel(window, modelId)) ?? [];
  const scoped = Boolean(
    modelId && usage?.windows.some((window) => window.provider || window.models),
  );
  const activeWindow = relevantWindow(usage, currentTime, modelId);
  const limited = scoped
    ? visibleWindows.some((window) => window.limited || window.usedPercent >= 100)
    : usage?.state === "limited";
  const low =
    (!scoped && usage?.state === "warning") ||
    Boolean(activeWindow && activeWindow.usedPercent >= 90);
  const name = harnessNames[harness];
  const consoleBilling = harness === "opencode" && modelProvider === "opencode";
  const billing = consoleBilling ? "api" : usage?.account?.billing;
  const page = usage?.usagePage ?? "subscription";
  const manage = async () => {
    setManagementError(false);
    try {
      await api.openHarnessUsage(harness, page);
    } catch {
      setManagementError(true);
    }
  };
  const provider =
    harness === "codex"
      ? page === "api"
        ? "OpenAI"
        : "ChatGPT"
      : harness === "claude"
        ? "Claude"
        : "OpenCode Console";
  return (
    <div
      ref={control}
      className="account-usage-control"
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        previewDismissed.current = false;
        showPreview();
      }}
      onPointerLeave={() => {
        clearTimeout(closePreview.current);
        closePreview.current = setTimeout(() => hidePreview(), 100);
      }}
      onFocusCapture={(event) => {
        if (event.target.closest(".account-usage-trigger")) showPreview();
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          previewDismissed.current = false;
          hidePreview();
        }
      }}
      onClickCapture={() => hidePreview(true)}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && previewOpen && !open) {
          event.preventDefault();
          event.stopPropagation();
          hidePreview(true);
        }
      }}
    >
      <SelectMenu
        key={`${projectId}:${harness}:${modelProvider ?? ""}`}
        label="Account & usage"
        describedBy={previewOpen && !open ? previewId : undefined}
        actionMenu
        value=""
        options={[]}
        onChange={() => {}}
        placement="top"
        align="start"
        maxMenuHeight={510}
        triggerClassName="account-usage-trigger"
        menuClassName={`${codeFontClassName} account-usage-popover`}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) hidePreview(true);
        }}
        triggerContent={
          <>
            <svg
              data-ph-private
              className="account-usage-ring"
              data-low={low || limited || undefined}
              aria-hidden="true"
              viewBox="0 0 20 20"
            >
              <circle cx="10" cy="10" r="7" />
              <circle
                cx="10"
                cy="10"
                r="7"
                pathLength="100"
                strokeDasharray={`${activeWindow ? remainingPercent(activeWindow) : 0} 100`}
              />
            </svg>
          </>
        }
        menuContent={() => (
          <div data-ph-private className="account-usage-content">
            <div className="account-usage-header">
              <HarnessIcon harness={harness} size={20} />
              <div>
                <div className="account-usage-plan">
                  {consoleBilling && usage
                    ? "OpenCode Console"
                    : (planName(harness, usage?.account?.plan) ?? name)}
                </div>
                <div className="account-usage-muted">
                  {[
                    usage?.account?.workspace,
                    billing === "api"
                      ? "API billing"
                      : billing === "subscription"
                        ? "Subscription"
                        : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Account & usage"}
                </div>
              </div>
              <Button
                className="account-usage-refresh"
                aria-label="Refresh account usage"
                title="Refresh account usage"
                data-select-initial
                disabled={snapshot.loading || !ready || !api.harnessUsage || !providerApplicable}
                onClick={() => {
                  setNow(Date.now());
                  void cache.refresh(true);
                }}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  data-loading={snapshot.loading || undefined}
                >
                  <path d="M16 7a6.5 6.5 0 1 0 .4 5M16 3v4h-4" />
                </svg>
              </Button>
            </div>
            <div className="account-usage-body">
              {visibleWindows.length || limited ? (
                <div className="account-usage-section">
                  {limited && (
                    <div className="account-usage-notice">
                      A usage limit has been reached. Check the reset time or your provider account.
                    </div>
                  )}
                  {visibleWindows.map((window) => (
                    <UsageWindow key={window.id} window={window} now={currentTime} />
                  ))}
                </div>
              ) : null}
              {!usage && snapshot.loading && (
                <div
                  className="account-usage-section account-usage-loading"
                  role="status"
                  aria-label="Loading account usage"
                >
                  <span />
                  <span />
                </div>
              )}
              {usage?.resets && usage.resets.availableCount > 0 && (
                <details className="account-usage-section account-usage-disclosure">
                  <summary>
                    Banked resets<span>{usage.resets.availableCount} available</span>
                  </summary>
                  <div className="account-usage-reset-list">
                    {usage.resets.items?.map((item) => (
                      <div className="account-usage-line" key={item.id}>
                        <span>{item.title ?? "Rate-limit reset"}</span>
                        <span className="account-usage-muted">
                          {item.expiresAt !== undefined && item.expiresAt !== null
                            ? `Expires ${new Date(item.expiresAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                            : item.expiresAt === null
                              ? "No expiry"
                              : "Expiry not reported"}
                        </span>
                      </div>
                    ))}
                    {!usage.resets.items?.length && (
                      <div className="account-usage-muted">
                        Expiry details aren't reported by this connection.
                      </div>
                    )}
                  </div>
                </details>
              )}
              {usage?.credits &&
                (usage.credits.unlimited || usage.credits.balance !== undefined) && (
                  <div className="account-usage-section account-usage-line">
                    <span>Credits</span>
                    <span className="account-usage-number">
                      {usage.credits.unlimited ? "Unlimited" : `${usage.credits.balance} remaining`}
                    </span>
                  </div>
                )}
              {tokens && (
                <details className="account-usage-section account-usage-disclosure">
                  <summary>
                    This conversation
                    <span>{tokenCount(tokens.inputTokens + tokens.outputTokens)} tokens</span>
                  </summary>
                  <div className="account-usage-token-list">
                    <div className="account-usage-line">
                      <span>Input</span>
                      <span>{tokens.inputTokens.toLocaleString()}</span>
                    </div>
                    <div className="account-usage-line account-usage-muted">
                      <span>Cached · included above</span>
                      <span>{tokens.cachedInputTokens.toLocaleString()}</span>
                    </div>
                    <div className="account-usage-line">
                      <span>Output</span>
                      <span>{tokens.outputTokens.toLocaleString()}</span>
                    </div>
                    {tokens.costUSD !== undefined && (
                      <>
                        <div className="account-usage-line">
                          <span>Estimated model cost</span>
                          <span>{dollars(tokens.costUSD)}</span>
                        </div>
                        <div className="account-usage-muted">
                          {billing === "subscription"
                            ? "API-equivalent estimate, not a subscription charge."
                            : "Model estimate. Check your provider for billed usage."}
                        </div>
                      </>
                    )}
                  </div>
                </details>
              )}
              {(usage?.note || !ready || !api.harnessUsage || !providerApplicable) && (
                <p className="account-usage-note">
                  {!ready
                    ? `Sign in to ${name} to view account usage.`
                    : !providerApplicable
                      ? "OpenCode doesn't expose account allowances for this model's provider."
                      : (usage?.note ??
                        "This connection doesn't report account limits. Check your provider account.")}
                </p>
              )}
              {ready && providerApplicable && snapshot.error && (
                <p className="account-usage-error" role="status">
                  {snapshot.error}
                </p>
              )}
              {managementError && (
                <p className="account-usage-error" role="alert">
                  Couldn't open the usage page. Try again.
                </p>
              )}
            </div>
            <div className="account-usage-footer">
              <span className="account-usage-muted" aria-live="polite">
                {snapshot.loading
                  ? "Refreshing…"
                  : usage
                    ? `${visibleWindows.length ? "Reported" : "Checked"} ${Date.now() - Date.parse(usage.updatedAt) < 60_000 ? "just now" : `${Math.floor(Math.max(0, now - Date.parse(usage.updatedAt)) / 60_000)}m ago`}`
                    : "Account limits unavailable"}
              </span>
              {providerApplicable && (
                <Button className="account-usage-manage" onClick={() => void manage()}>
                  {provider}
                  <span aria-hidden="true">↗</span>
                </Button>
              )}
            </div>
          </div>
        )}
      />
      {previewOpen && !open && (
        <div
          ref={preview}
          id={previewId}
          className={`${codeFontClassName} account-usage-preview`}
          role="tooltip"
          popover="manual"
          data-ph-private
        >
          <div className="account-usage-preview-heading">
            <HarnessIcon harness={harness} size={16} />
            <span>
              {consoleBilling && usage
                ? "OpenCode Console"
                : (planName(harness, usage?.account?.plan) ?? name)}
            </span>
          </div>
          {visibleWindows.slice(0, 2).map((window) => (
            <div className="account-usage-preview-window" key={window.id}>
              <div className="account-usage-line">
                <span>{window.name}</span>
                <span>
                  {window.resetsAt !== undefined && window.resetsAt * 1000 <= currentTime
                    ? "Checking…"
                    : percentLabel(window)}
                </span>
              </div>
              {window.resetsAt !== undefined && (
                <div className="account-usage-muted">{untilTime(window.resetsAt, currentTime)}</div>
              )}
            </div>
          ))}
          {!visibleWindows.length && (
            <div className="account-usage-muted">
              {!ready
                ? `Sign in to ${name} to view usage.`
                : limited
                  ? "Usage limit reached"
                  : snapshot.loading
                    ? "Checking usage…"
                    : "Account limits unavailable"}
            </div>
          )}
          {usage?.resets && usage.resets.availableCount > 0 && (
            <div className="account-usage-line account-usage-muted">
              <span>Banked resets</span>
              <span>{usage.resets.availableCount} available</span>
            </div>
          )}
          <div className="account-usage-preview-hint">Click for full details</div>
        </div>
      )}
    </div>
  );
});
