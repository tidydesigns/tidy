import { useMemo, useState } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { RepositoryContext } from "../../../../shared/contracts/repository-context";
import {
  codeContextTriggerClassName,
  codeMenuClassName,
  codeScrollbarClassName,
} from "../../styles/code-ui";
import { ComposerChevron, ComposerIcon } from "./composer-icon";
import { BranchName } from "./branch-name";
import "./branch-picker.css";

const maxVisibleBranches = 200;

function threadMenuHeight(trigger: HTMLButtonElement) {
  const composer = trigger.closest(".thread-workspace")?.querySelector(".composer");
  if (!composer) return 256;
  const available =
    composer.getBoundingClientRect().top - trigger.getBoundingClientRect().bottom - 12;
  return Math.max(128, Math.min(256, available));
}

export function BranchPicker({
  repository,
  disabled,
  onChange,
  placement = "top",
}: {
  repository?: RepositoryContext;
  disabled: boolean;
  placement?: Parameters<typeof SelectMenu>[0]["placement"];
  onChange(branch: string): void;
}) {
  const [query, setQuery] = useState("");
  const branchLabel = repository ? (repository.branch ?? "Detached HEAD") : "Branch";
  const numberFormat = useMemo(() => new Intl.NumberFormat(), []);
  const branches = useMemo(() => {
    const rank = (branch: string) =>
      branch === repository?.branch ? 0 : branch === "main" ? 1 : 2;
    return [...(repository?.branches ?? [])].sort(
      (a, b) => rank(a) - rank(b) || a.localeCompare(b),
    );
  }, [repository?.branches, repository?.branch]);
  const search = query.trim().toLowerCase();
  const matches = branches.filter((branch) => branch.toLowerCase().includes(search));
  const visible = matches.slice(0, maxVisibleBranches);

  return (
    <SelectMenu
      label="Project branch"
      value={repository?.branch ?? branchLabel}
      disabled={disabled}
      placement={placement}
      placementFallback="resize"
      align="end"
      maxMenuHeight={placement === "bottom" ? threadMenuHeight : 256}
      selectionIndicator="none"
      onOpenChange={() => setQuery("")}
      triggerClassName={`${codeContextTriggerClassName} branch-trigger max-w-[175px] max-[700px]:max-w-[115px]`}
      triggerContent={
        <>
          <ComposerIcon name="branch" />
          <BranchName name={branchLabel} revealOnFocus={false} />
          <ComposerChevron />
        </>
      }
      menuClassName={`${codeMenuClassName} branch-menu`}
      menuHeader={
        <label className="branch-search">
          <ComposerIcon name="search" />
          <input
            data-select-search
            data-ph-private
            type="search"
            aria-label="Search branches"
            placeholder="Search branches…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              event.currentTarget
                .closest('[role="menu"]')
                ?.querySelector(".branch-options")
                ?.scrollTo({ top: 0 });
            }}
          />
        </label>
      }
      emptyMessage={branches.length === 0 ? "No local branches yet" : "No matches"}
      renderOptionLabel={(option) => <BranchName name={option.label} />}
      optionsClassName={`branch-options ${codeScrollbarClassName}`}
      options={visible.map((branch) => ({
        value: branch,
        label: branch,
        ariaLabel: branch,
        description: branch === repository?.branch ? "current" : undefined,
      }))}
      menuFooter={
        <p className="branch-count" role="status">
          {matches.length > maxVisibleBranches
            ? `Showing ${numberFormat.format(visible.length)} of ${numberFormat.format(matches.length)} branches`
            : `${numberFormat.format(matches.length)} ${search ? "matching " : ""}${matches.length === 1 ? "branch" : "branches"}`}
          {matches.length > maxVisibleBranches && (
            <span className="branch-search-hint">Search to narrow results</span>
          )}
        </p>
      }
      onChange={onChange}
    />
  );
}
