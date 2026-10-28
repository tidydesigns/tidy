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
  const name = harness === "codex" ? "Codex" : "Claude Code";
  const defaultEffort = details?.defaultEffort ?? model?.defaultEffort;
  const effort = settings.effort ?? defaultEffort;
  return (
    <>
      <ModelPicker
        harness={harness}
        modelId={modelId}
        catalogs={catalogs}
        disabled={disabled}
        onHarnessChange={onHarnessChange}
        onRefresh={onRefresh}
        onChange={onModelChange}
      />
      {model && model.efforts.length > 0 && (
        <div
          title={
            effort
              ? "Reasoning effort for this thread."
              : `${name} has not reported its configured effort. Choose an effort for this thread.`
          }
        >
          <SelectMenu
            label="Effort"
            triggerContent={
              <>
                <ComposerIcon name="effort" />
                <span>{effort ? effortLabel(effort) : "Choose effort"}</span>
                <ComposerChevron />
              </>
            }
            menuClassName={`${codeMenuClassName} effort-menu [&]:min-w-[130px]`}
            placement="top"
            value={effort ?? ""}
            disabled={disabled}
            triggerClassName={codeControlClassName}
            options={[
              ...(!effort ? [{ value: "", label: "Choose effort", disabled: true }] : []),
              ...model.efforts.map((value) => ({
                value,
                label: effortLabel(value),
              })),
              ...(effort && !model.efforts.includes(effort)
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
          menuClassName={`${codeMenuClassName} access-menu [&]:w-[165px] [&]:min-w-0 [&_.permission-icon]:static [&_[data-slot=select-menu-label]]:p-0`}
          placement="top"
          showSelectedIcon
          selectionIndicator="none"
          value={effectivePermissionMode(harness, settings.permissionMode)}
          disabled={disabled}
          triggerClassName={codeControlClassName}
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
