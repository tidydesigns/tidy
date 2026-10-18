import { useLayoutEffect, useRef, useState } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Button } from "@tidy/ui/button";
import { HarnessIcon } from "@tidy/ui/harness-icon";
import type { DesktopAPI, HarnessConnection, HarnessId } from "../../shared/contracts";
import type { HarnessDetails, HarnessSettings, TokenUsage } from "../../shared/harness-settings";
import {
  permissionModes,
  effectivePermissionMode,
  type PermissionMode,
} from "../../shared/permissions";

const number = (value: number) => value.toLocaleString();
const effortLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
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
  actualModel,
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
  actualModel?: string;
  usage?: TokenUsage;
  details?: HarnessDetails;
  error?: string;
  loading: boolean;
  disabled: boolean;
  onHarnessChange?: (harness: HarnessId) => void;
  onSettingsChange(settings: HarnessSettings): void;
  onRefresh(): void;
}) {
  const configuredModel = settings.model ?? actualModel ?? details?.defaultModel;
  const modelId = configuredModel === "default" ? undefined : configuredModel;
  const model = details?.models.find((model) => model.id === (modelId ?? "default"));
  const name = harness === "codex" ? "Codex" : "Claude Code";
  const defaultEffort = details?.defaultEffort ?? model?.defaultEffort;
  const effort = settings.effort ?? defaultEffort;
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
      {details?.models.length ? (
        <div
          title={
            modelId
              ? model?.description
              : `${name} has not reported its configured model. Choose a model for this thread.`
          }
        >
          <SelectMenu
            label="Model"
            placement="top"
            value={modelId ?? ""}
            disabled={disabled}
            triggerClassName="harness-setting-trigger"
            options={[
              ...(!modelId ? [{ value: "", label: "Choose model", disabled: true }] : []),
              ...(details?.models
                .filter((model) => model.id !== "default")
                .map((model) => ({ value: model.id, label: model.name })) ?? []),
              ...(modelId && !details.models.some((model) => model.id === modelId)
                ? [{ value: modelId, label: modelId, disabled: true }]
                : []),
            ]}
            onChange={(value) =>
              onSettingsChange({
                ...settings,
                model: value,
                effort: details.models.find((model) => model.id === value)?.defaultEffort,
              })
            }
          />
        </div>
      ) : (
        <Button
          type="button"
          className="harness-setting-trigger"
          disabled={loading || disabled}
          title={error ?? "Load the connected harness's model choices."}
          onClick={onRefresh}
        >
          {loading ? "Loading models…" : "Retry models"}
        </Button>
      )}
      {Boolean(model?.efforts.length) && (
        <div
          title={
            effort
              ? "Reasoning effort for this thread."
              : `${name} has not reported its configured effort. Choose an effort for this thread.`
          }
        >
          <SelectMenu
            label="Effort"
            placement="top"
            value={effort ?? ""}
            disabled={disabled}
            triggerClassName="harness-setting-trigger"
            options={[
              ...(!effort ? [{ value: "", label: "Choose effort", disabled: true }] : []),
              ...model!.efforts.map((value) => ({
                value,
                label: effortLabel(value),
              })),
              ...(effort && !model!.efforts.includes(effort)
                ? [{ value: effort, label: effortLabel(effort), disabled: true }]
                : []),
            ]}
            onChange={(value) => onSettingsChange({ ...settings, effort: value })}
          />
        </div>
      )}
      <div
        className="permission-control"
        title={
          permissionModes[harness].find(
            (option) => option.value === effectivePermissionMode(harness, settings.permissionMode),
          )?.description
        }
      >
        <SelectMenu
          label="Permissions"
          placement="top"
          value={effectivePermissionMode(harness, settings.permissionMode)}
          disabled={disabled}
          triggerClassName="harness-setting-trigger"
          options={permissionModes[harness]}
          onChange={(value) =>
            onSettingsChange({ ...settings, permissionMode: value as PermissionMode })
          }
        />
      </div>
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
