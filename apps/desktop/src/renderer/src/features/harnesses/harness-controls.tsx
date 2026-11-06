import { harnessNames } from "../../../../shared/contracts/harness-updates";
import { codeControlClassName, codeMenuClassName } from "../../styles/code-ui";
import type { HarnessCatalog, ModelSelection } from "./harness-catalog";
import { ModelPicker } from "./model-picker";
import { ComposerChevron, ComposerIcon } from "../composer/composer-icon";
import { SelectMenu } from "@tidy/ui/select-menu";
import { PermissionIcon } from "./permission-icon";
import type { HarnessId } from "../../../../shared/contracts/desktop";
import type { HarnessSettings } from "../../../../shared/contracts/harness-settings";
import {
  permissionModes,
  effectivePermissionMode,
  permissionModeSchema,
} from "../../../../shared/contracts/permissions";

const effortLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
export function HarnessControls({
  harness,
  settings,
  actualModel,
  disabled,
  onHarnessChange,
  catalogs,
  onModelChange,
  onSettingsChange,
  onRefresh,
}: {
  harness: HarnessId;
  settings: HarnessSettings;
  actualModel?: string;
  disabled: boolean;
  onHarnessChange?: (harness: HarnessId) => void;
  catalogs: HarnessCatalog[];
  onModelChange(selection: ModelSelection): void;
  onSettingsChange(settings: HarnessSettings): void;
  onRefresh(): void;
}) {
  const details = catalogs.find((catalog) => catalog.connection.id === harness)?.details;
  const configuredModel = settings.model ?? actualModel ?? details?.defaultModel;
  const modelId = configuredModel === "default" ? undefined : configuredModel;
  const model = details?.models.find((model) => model.id === (modelId ?? "default"));
  const name = harnessNames[harness];
  const defaultEffort = details?.defaultEffort ?? model?.defaultEffort;
  const effort = model?.efforts.length ? (settings.effort ?? defaultEffort) : undefined;
  const supportsFastMode = model?.supportsFastMode === true;
  const fastMode =
    settings.fastMode ??
    (supportsFastMode && (details?.defaultFastMode ?? model?.defaultFastMode ?? false));
  const showFastMode = supportsFastMode || fastMode;
  return (
    <>
      <ModelPicker
        harness={harness}
        modelId={modelId}
        catalogs={catalogs}
        disabled={disabled}
        onHarnessChange={onHarnessChange}
        onRefresh={onRefresh}
        onChange={(selection) => {
          const selectedModel = catalogs
            .find((catalog) => catalog.connection.id === selection.harness)
            ?.details?.models.find((item) => item.id === selection.settings.model);
          onModelChange({
            ...selection,
            settings: {
              ...selection.settings,
              fastMode: selectedModel?.supportsFastMode
                ? selection.harness === harness
                  ? settings.fastMode
                  : undefined
                : selection.harness === harness && (settings.fastMode !== undefined || fastMode)
                  ? false
                  : undefined,
            },
          });
        }}
      />
      {model && (model.efforts.length > 0 || showFastMode) && (
        <div
          title={
            supportsFastMode
              ? "Reasoning effort and speed for this thread. Fast mode uses more credits or higher provider rates."
              : effort
                ? "Reasoning effort for this thread."
                : `${name} has not reported its configured effort. Choose an effort for this thread.`
          }
        >
          <SelectMenu
            label={
              model.efforts.length
                ? fastMode
                  ? "Effort, Fast mode on"
                  : "Effort"
                : fastMode
                  ? "Speed: Fast"
                  : "Speed: Standard"
            }
            actionMenu={model.efforts.length === 0}
            triggerContent={
              <>
                <ComposerIcon name="effort" />
                <span className="inline-flex items-center gap-1.5">
                  {effort
                    ? effortLabel(effort)
                    : model.efforts.length
                      ? "Choose effort"
                      : fastMode
                        ? "Fast"
                        : "Standard"}
                  {fastMode && (effort || model.efforts.length > 0) && (
                    <span className="border-l border-border pl-1.5">Fast</span>
                  )}
                </span>
                <ComposerChevron />
              </>
            }
            menuClassName={`${codeMenuClassName} effort-menu [&]:min-w-[130px] [&_[role=separator]]:border-border`}
            placement="top"
            value={effort ?? ""}
            disabled={disabled}
            triggerClassName={`${codeControlClassName} effort-trigger`}
            options={[
              ...(!effort && model.efforts.length
                ? [{ value: "", label: "Choose effort", disabled: true }]
                : []),
              ...model.efforts.map((value) => ({
                value,
                label: effortLabel(value),
              })),
              ...(effort && !model.efforts.includes(effort)
                ? [{ value: effort, label: effortLabel(effort), disabled: true }]
                : []),
              ...(showFastMode
                ? [
                    {
                      value: ":fast-mode",
                      label: "Fast",
                      ariaLabel: supportsFastMode
                        ? "Fast mode (higher usage)"
                        : "Fast mode unavailable; turn off",
                      checked: fastMode,
                      separatorBefore: model.efforts.length > 0,
                    },
                  ]
                : []),
            ]}
            onChange={(value) =>
              onSettingsChange(
                value === ":fast-mode"
                  ? { ...settings, fastMode: !fastMode }
                  : { ...settings, effort: value },
              )
            }
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
          menuClassName={`${codeMenuClassName} access-menu [&]:w-[165px] [&]:min-w-0 [&_.permission-icon]:static [&_[data-slot=select-menu-label]]:p-0`}
          placement="top"
          showSelectedIcon
          selectionIndicator="none"
          value={effectivePermissionMode(harness, settings.permissionMode)}
          disabled={disabled}
          triggerClassName={`${codeControlClassName} permission-trigger`}
          options={permissionModes[harness].map((option) => ({
            value: option.value,
            label: option.label,
            icon: <PermissionIcon mode={option.value} />,
          }))}
          onChange={(value) => {
            const permissionMode = permissionModeSchema.parse(value);
            onSettingsChange({ ...settings, permissionMode });
          }}
        />
      </div>
    </>
  );
}
