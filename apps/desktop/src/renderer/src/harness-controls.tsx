import { useLayoutEffect, useRef, useState } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Button } from "@tidy/ui/button";
import { HarnessIcon } from "@tidy/ui/harness-icon";
import type { DesktopAPI, HarnessConnection, HarnessId } from "../../shared/contracts";
import type { HarnessDetails, HarnessSettings, TokenUsage } from "../../shared/harness-settings";

const number = (value: number) => value.toLocaleString();
export function TokenUsageDetails({ usage }: { usage: TokenUsage }) {
  return (
    <dl className="usage-statistics">
      <div>
        <dt>Input tokens</dt>
        <dd>{number(usage.inputTokens)}</dd>
      </div>
      <div>
        <dt>Cached input</dt>
        <dd>{number(usage.cachedInputTokens)}</dd>
      </div>
      <div>
        <dt>Output tokens</dt>
        <dd>{number(usage.outputTokens)}</dd>
      </div>
      {usage.costUSD !== undefined && (
        <div title="The harness's API cost estimate. This is not a subscription charge or billing statement.">
          <dt>Estimated API cost</dt>
          <dd>${usage.costUSD.toFixed(2)}</dd>
        </div>
      )}
    </dl>
  );
}
export function HarnessControls({
  api,
  connections,
  harness,
  settings,
  usage,
  details,
  error,
  loading,
  disabled,
  onHarnessChange,
  onSettingsChange,
  onRefresh,
}: {
  api: DesktopAPI;
  connections: HarnessConnection[];
  harness: HarnessId;
  settings: HarnessSettings;
  usage?: TokenUsage;
  details?: HarnessDetails;
  error?: string;
  loading: boolean;
  disabled: boolean;
  onHarnessChange?: (harness: HarnessId) => void;
  onSettingsChange(settings: HarnessSettings): void;
  onRefresh(): void;
}) {
  const model = details?.models.find(
    (model) => model.id === (settings.model ?? details.defaultModel),
  );
  const name = harness === "codex" ? "Codex" : "Claude Code";
  const [usageOpen, setUsageOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!usageOpen || !popup.current || !button.current) return;
    const panel = popup.current;
    panel.showPopover();
    const bounds = button.current.getBoundingClientRect(),
      size = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(bounds.right - size.width, innerWidth - size.width - 8))}px`;
    panel.style.top = `${Math.max(8, bounds.top - size.height - 8)}px`;
    const dismiss = () => setUsageOpen(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        button.current?.focus();
      }
    };
    const scrolled = (event: Event) => {
      if (!(event.target instanceof Node && panel.contains(event.target))) dismiss();
    };
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", scrolled, true);
    document.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("keydown", key);
    };
  }, [usageOpen]);
  return (
    <>
      {onHarnessChange ? (
        <SelectMenu
          label="Coding harness"
          value={harness}
          placement="top"
          triggerClassName="harness-icon-trigger"
          triggerContent={<HarnessIcon harness={harness} size={18} />}
          options={connections.map((connection) => ({
            value: connection.id,
            label:
              connection.status === "ready"
                ? connection.name
                : `${connection.name} · ${connection.status === "signed-out" ? "Sign in required" : "Not installed"}`,
            icon: <HarnessIcon harness={connection.id} />,
          }))}
          onChange={(value) => {
            setUsageOpen(false);
            onHarnessChange(value as HarnessId);
          }}
        />
      ) : (
        <span className="harness-icon-label" role="img" aria-label={name} title={name}>
          <HarnessIcon harness={harness} size={18} />
        </span>
      )}
      <SelectMenu
        label="Model"
        placement="top"
        value={settings.model ?? ""}
        disabled={disabled || !details?.models.length}
        triggerClassName="harness-setting-trigger"
        options={[
          { value: "", label: "Default model" },
          ...(details?.models
            .filter((model) => model.id !== "default")
            .map((model) => ({ value: model.id, label: model.name })) ?? []),
          ...(settings.model && !details?.models.some((model) => model.id === settings.model)
            ? [{ value: settings.model, label: settings.model, disabled: true }]
            : []),
        ]}
        onChange={(value) =>
          onSettingsChange({
            model: value || undefined,
            effort: value
              ? details?.models.find((model) => model.id === value)?.defaultEffort
              : undefined,
          })
        }
      />
      {Boolean(model?.efforts.length) && (
        <SelectMenu
          label="Effort"
          placement="top"
          value={settings.effort ?? ""}
          disabled={disabled}
          triggerClassName="harness-setting-trigger"
          options={[
            { value: "", label: "Default effort" },
            ...model!.efforts.map((value) => ({
              value,
              label: value.charAt(0).toUpperCase() + value.slice(1),
            })),
          ]}
          onChange={(value) => onSettingsChange({ ...settings, effort: value || undefined })}
        />
      )}
      <Button
        ref={button}
        type="button"
        className="quiet-button usage-trigger"
        aria-expanded={usageOpen}
        aria-controls={usageOpen ? "harness-usage" : undefined}
        onClick={() => setUsageOpen((value) => !value)}
      >
        Usage
      </Button>
      {usageOpen && (
        <div
          ref={popup}
          id="harness-usage"
          popover="auto"
          className="harness-usage"
          aria-label={`${name} usage`}
          onToggle={(event) => {
            if ((event.nativeEvent as ToggleEvent).newState === "closed") setUsageOpen(false);
          }}
        >
          <div className="usage-heading">
            <strong>
              <HarnessIcon harness={harness} />
              {name} usage
            </strong>
            <Button type="button" className="quiet-button" disabled={loading} onClick={onRefresh}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          {details?.windows.map((window, index) => (
            <div className="usage-window" key={index}>
              <div>
                <span>{window.name}</span>
                <span>{Math.round(window.usedPercent)}% used</span>
              </div>
              <progress value={window.usedPercent} max={100} aria-label={`${window.name} usage`} />
              {window.resetsAt && (
                <small>
                  Resets{" "}
                  {new Date(window.resetsAt * 1000).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </small>
              )}
            </div>
          ))}
          {(error || details?.usageError) && (
            <p className="usage-notice">{error ?? details?.usageError}</p>
          )}
          {!details && !error && (
            <p className="usage-notice">
              {loading
                ? "Checking the connected harness…"
                : "Account usage has not been checked yet."}
            </p>
          )}
          {usage && (
            <div className="thread-token-usage">
              <span>Thread usage</span>
              <TokenUsageDetails usage={usage} />
            </div>
          )}
          <Button
            type="button"
            className="quiet-button usage-link"
            onClick={() =>
              void api
                .openHarnessUsage(harness, details?.usagePage ?? "subscription")
                .catch(console.error)
            }
          >
            Open provider usage ↗
          </Button>
        </div>
      )}
    </>
  );
}
