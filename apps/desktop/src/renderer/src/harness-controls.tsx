import type { HarnessCatalog, ModelSelection } from "./harness-catalog";
import { ModelPicker } from "./model-picker";
import { ComposerChevron, ComposerIcon } from "./composer-icon";
import { SelectMenu } from "@tidy/ui/select-menu";
import { PermissionIcon } from "./permission-icon";
import type { HarnessId } from "../../shared/contracts";
import type { HarnessSettings } from "../../shared/harness-settings";
import {
  permissionModes,
  effectivePermissionMode,
  permissionModeSchema,
} from "../../shared/permissions";

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
            showSelectedIcon
            triggerContent={
              <>
                <ComposerIcon name="effort" />
                <span>{effort ? effortLabel(effort) : "Choose effort"}</span>
                <ComposerChevron />
              </>
            }
            menuClassName="compact-composer-menu effort-menu"
            placement="top"
            value={effort ?? ""}
            disabled={disabled}
            triggerClassName="harness-setting-trigger"
            options={[
              ...(!effort ? [{ value: "", label: "Choose effort", disabled: true }] : []),
              ...model.efforts.map((value) => ({
                value,
                label: effortLabel(value),
                icon: <ComposerIcon name="effort" />,
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
          menuClassName="compact-composer-menu access-menu"
          placement="top"
          showSelectedIcon
          selectionIndicator="none"
          value={effectivePermissionMode(harness, settings.permissionMode)}
          disabled={disabled}
          triggerClassName="harness-setting-trigger"
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
