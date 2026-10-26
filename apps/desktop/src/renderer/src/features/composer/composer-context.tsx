import {
  codeMenuClassName,
  codeContextClassName,
  codeContextTriggerClassName,
} from "../../styles/code-ui";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { DesignSummary } from "../../../../shared/contracts/desktop";
import type { RepositoryContext } from "../../../../shared/contracts/repository-context";
import { ComposerChevron, ComposerIcon } from "./composer-icon";

export function ComposerContext({
  repository,
  designs,
  selected,
  onReferencesChange,
  onBranchChange,
  disabled,
  branchDisabled = false,
  pending,
  execution,
}: {
  repository?: RepositoryContext;
  designs: Pick<DesignSummary, "id" | "name">[];
  selected: string[];
  onReferencesChange?: (ids: string[]) => void;
  onBranchChange(branch: string): void;
  disabled: boolean;
  branchDisabled?: boolean;
  pending: boolean;
  execution?: {
    value: string;
    options: Array<{ value: string; label: string; description?: string }>;
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
          disabled={disabled || !execution.onChange}
          placement="top"
          align="start"
          triggerClassName={codeContextTriggerClassName}
          menuClassName={codeMenuClassName}
        />
      )}
      <span
        className={`context-machine ml-auto ${codeContextClassName} [&>span]:max-w-[135px] [&>span]:truncate max-[700px]:[&>span]:max-w-[85px]`}
        title={repository?.machine}
      >
        <ComposerIcon name="machine" />
        <span>{repository?.machine ?? "This machine"}</span>
      </span>
      <SelectMenu
        label="Branch"
        value={repository?.branch ?? ""}
        disabled={disabled || branchDisabled || pending || !repository?.repository}
        placement="top"
        align="end"
        triggerClassName={`${codeContextTriggerClassName} branch-trigger max-w-[175px] max-[700px]:max-w-[115px]`}
        triggerContent={
          <>
            <ComposerIcon name="branch" />
            <span>
              {repository
                ? repository.repository
                  ? (repository.branch ?? "Detached HEAD")
                  : "No repository"
                : "Branch"}
            </span>
            <ComposerChevron />
          </>
        }
        menuClassName={`${codeMenuClassName} branch-menu [&]:max-w-[min(300px,calc(100vw_-_16px))]`}
        options={repository?.branches.map((branch) => ({ value: branch, label: branch })) ?? []}
        onChange={onBranchChange}
      />
    </div>
  );
}
