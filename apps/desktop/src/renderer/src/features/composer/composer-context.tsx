import {
  codeMenuClassName,
  codeContextClassName,
  codeContextTriggerClassName,
} from "../../styles/code-ui";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { DesignSummary } from "../../../../shared/contracts/desktop";
import type { RepositoryContext } from "../../../../shared/contracts/repository-context";
import { ComposerChevron, ComposerIcon } from "./composer-icon";
import { BranchPicker } from "./branch-picker";
import type { WorkspaceMachine } from "../../../../shared/remote";

export function ComposerContext({
  repository,
  threadMode,
  branchDisabled,
  designs,
  selected,
  onReferencesChange,
  onBranchChange,
  branchPlacement,
  disabled,
  pending,
  execution,
  machine,
}: {
  repository?: RepositoryContext;
  branchDisabled?: boolean;
  threadMode?: {
    value: "worktree" | "local";
    path?: string;
    onChange?(value: "worktree" | "local"): void;
  };
  designs: Pick<DesignSummary, "id" | "name">[];
  selected: string[];
  onReferencesChange?: (ids: string[]) => void;
  onBranchChange(branch: string): void;
  branchPlacement?: Parameters<typeof BranchPicker>[0]["placement"];
  disabled: boolean;
  pending: boolean;
  machine?: {
    label: string;
    value?: string;
    options?: WorkspaceMachine[];
    onChange?(id: string): void;
  };
  execution?: {
    value: string;
    disabled?: boolean;
    options: Array<{ value: string; label: string; description?: string; disabled?: boolean }>;
    onChange?(value: string): void;
  };
}) {
  const references = designs.filter((design) => selected.includes(design.id));
  return (
    <div
      className="composer-context flex min-w-0 items-center gap-2 max-[700px]:gap-[3px]"
      data-ph-private
    >
      {onReferencesChange ? (
        <SelectMenu
          label="Design references"
          actionMenu
          closeOnSelect={false}
          placement="top"
          align="start"
          value=""
          disabled={disabled}
          triggerClassName={`${codeContextTriggerClassName} reference-trigger`}
          triggerContent={
            <>
              <ComposerIcon name="reference" />
              <span>Design references{selected.length ? ` · ${selected.length}` : ""}</span>
              <ComposerChevron />
            </>
          }
          menuClassName={`${codeMenuClassName} reference-menu [&]:max-w-[min(280px,calc(100vw_-_16px))]`}
          options={designs.map((design) => ({
            value: design.id,
            label: design.name,
            checked: selected.includes(design.id),
            disabled: !selected.includes(design.id) && selected.length >= 20,
          }))}
          onChange={(id) =>
            onReferencesChange(
              selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id],
            )
          }
        />
      ) : references.length > 0 ? (
        <span
          className={`thread-references ${codeContextClassName}`}
          title={references.map((design) => design.name).join(", ")}
        >
          <ComposerIcon name="reference" />
          {references.length} {references.length === 1 ? "reference" : "references"}
        </span>
      ) : null}
      {execution && (
        <SelectMenu
          label="Local project"
          value={execution.value}
          options={execution.options}
          onChange={(value) => execution.onChange?.(value)}
          disabled={(execution.disabled ?? disabled) || !execution.onChange}
          placement="top"
          align="start"
          triggerClassName={codeContextTriggerClassName}
          menuClassName={codeMenuClassName}
        />
      )}
      {threadMode &&
        (threadMode.onChange ? (
          <SelectMenu
            label="Thread workspace"
            value={threadMode.value}
            disabled={disabled}
            placement="top"
            align="start"
            triggerClassName={codeContextTriggerClassName}
            menuClassName={codeMenuClassName}
            options={[
              {
                value: "worktree",
                label: "New worktree",
                description:
                  "Separate branch from committed HEAD. Uncommitted changes are not copied.",
              },
              {
                value: "local",
                label: "Current folder",
                description:
                  "Use existing files and uncommitted changes. One active thread per checkout.",
              },
            ]}
            onChange={(value) => threadMode.onChange?.(value as "worktree" | "local")}
          />
        ) : (
          <span
            className={`${codeContextClassName} shrink-0 whitespace-nowrap`}
            title={
              threadMode.path ??
              (threadMode.value === "worktree"
                ? "This thread continues in its original worktree."
                : "This thread uses the project's existing folder.")
            }
          >
            {threadMode.value === "worktree" ? "Worktree" : "Current folder"}
          </span>
        ))}
      {machine?.onChange && machine.options && machine.options.length > 1 ? (
        <SelectMenu
          label="Run on"
          value={machine.value ?? "local"}
          disabled={disabled}
          placement="top"
          align="end"
          className="context-machine ml-auto min-w-0"
          triggerClassName={`${codeContextTriggerClassName} max-w-[170px] max-[700px]:max-w-[110px]`}
          menuClassName={`${codeMenuClassName} [&]:min-w-[220px]! [&]:max-w-[min(320px,calc(100vw-16px))]`}
          menuHeader={<p className="m-0 px-2 pt-1 pb-2 text-[11px] text-muted-ink">Run on</p>}
          triggerContent={
            <>
              <ComposerIcon name="machine" />
              <span>{machine.label}</span>
              <ComposerChevron />
            </>
          }
          options={machine.options.map((item) => ({
            value: item.id,
            label: item.label,
            description:
              item.id === "local"
                ? "This device"
                : item.status?.kind === "connected"
                  ? "Connected"
                  : item.status?.kind === "reconnecting"
                    ? "Reconnecting…"
                    : "Offline",
            icon: (
              <span
                className={`size-1.5 shrink-0 rounded-full ${item.id === "local" || item.status?.kind === "connected" ? "bg-emerald-500" : "bg-muted-ink/40"}`}
              />
            ),
          }))}
          onChange={machine.onChange}
        />
      ) : (
        <span
          className={`context-machine ml-auto ${codeContextClassName} [&>span]:max-w-[135px] [&>span]:truncate max-[700px]:[&>span]:max-w-[85px]`}
          title={machine?.label ?? repository?.machine}
        >
          <ComposerIcon name="machine" />
          <span>{machine?.label ?? repository?.machine ?? "This machine"}</span>
        </span>
      )}
      {repository && !repository.repository ? (
        <span className={`${codeContextClassName} p-1.5`}>
          <ComposerIcon name="branch" />
          <span>No repository</span>
        </span>
      ) : (
        <BranchPicker
          repository={repository}
          placement={branchPlacement}
          disabled={disabled || branchDisabled || pending || !repository?.repository}
          onChange={onBranchChange}
        />
      )}
    </div>
  );
}
