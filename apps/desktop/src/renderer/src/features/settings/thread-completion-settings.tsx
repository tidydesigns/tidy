import { useId, useState, useSyncExternalStore } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import { showToast } from "@tidy/ui/toast";
import {
  completionHealth,
  subscribeCompletionHealth,
  retryCompletionChecks,
} from "./thread-completion-health";
import {
  threadCompletionSchema,
  type ThreadCompletion,
} from "../../../../shared/contracts/thread-completion";
import {
  currentThreadCompletion,
  selectThreadCompletion,
  subscribeThreadCompletion,
} from "./thread-completion-preferences";

export function ThreadCompletionSettings() {
  const preferences = useSyncExternalStore(subscribeThreadCompletion, currentThreadCompletion);
  const failures = useSyncExternalStore(subscribeCompletionHealth, completionHealth);
  const id = useId();
  const [branchDraft, setBranchDraft] = useState<string>();
  const branches = branchDraft ?? preferences.branches.join(", ");
  const branchNames = branches
    .split(",")
    .map((branch) => branch.trim())
    .filter(Boolean);
  const validBranches = threadCompletionSchema.shape.branches.safeParse(branchNames).success;
  function change(patch: Partial<ThreadCompletion>) {
    if (!selectThreadCompletion({ ...currentThreadCompletion(), ...patch }))
      showToast("Completion rules changed for this session, but could not be remembered.");
  }
  function toggle(key: "merged" | "closed", label: string) {
    return (
      <Button
        className="completion-switch"
        role="switch"
        aria-label={label}
        aria-checked={preferences[key]}
        onClick={() => change({ [key]: !preferences[key] })}
      >
        <span />
      </Button>
    );
  }
  return (
    <section className="thread-completion-settings" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Automatically move to Done</h2>
      <p className="thread-naming-note">
        Applies to existing and new threads in your connected projects while Tidy is open.
      </p>
      {failures.length > 0 &&
        (preferences.merged || preferences.closed || preferences.inactiveDays > 0) && (
          <div className="completion-row" role="status">
            <p>
              Automatic completion could not check or update threads in {failures.join(", ")}. Tidy
              will retry automatically.
            </p>
            <Button type="button" className="quiet-button shrink-0" onClick={retryCompletionChecks}>
              Retry now
            </Button>
          </div>
        )}
      <div className="completion-row">
        <div>
          <span>Pull request merged</span>
          <p>Finish threads when their linked PRs are merged.</p>
        </div>
        {toggle("merged", "Pull request merged")}
      </div>
      {preferences.merged && (
        <>
          <div className="completion-row">
            <span id={`${id}-target`}>Merged into</span>
            <SelectMenu
              value={preferences.target}
              label="Merged into"
              labelledBy={`${id}-target`}
              size="sm"
              className="w-52 shrink-0"
              options={[
                { value: "default", label: "Repository default branch" },
                { value: "named", label: "Specific branches" },
                { value: "any", label: "Any branch" },
              ]}
              onChange={(target) => change({ target: target as ThreadCompletion["target"] })}
            />
          </div>
          {preferences.target === "default" && (
            <p className="thread-naming-note">
              Uses each repository’s default branch, whether it is main, master, or another name.
            </p>
          )}
          {preferences.target === "named" && (
            <div className="completion-branches">
              <label htmlFor={`${id}-branches`}>Branch names</label>
              <input
                id={`${id}-branches`}
                className="thread-naming-textarea"
                value={branches}
                placeholder="main, production, release"
                maxLength={4096}
                aria-invalid={!validBranches || !branchNames.length}
                aria-describedby={`${id}-branch-help`}
                onChange={(event) => {
                  const value = event.target.value;
                  setBranchDraft(value);
                  const names = [
                    ...new Set(
                      value
                        .split(",")
                        .map((branch) => branch.trim())
                        .filter(Boolean),
                    ),
                  ];
                  change({
                    branches: threadCompletionSchema.shape.branches.safeParse(names).success
                      ? names
                      : [],
                  });
                }}
                onBlur={() => {
                  if (validBranches) setBranchDraft(undefined);
                }}
              />
              <p id={`${id}-branch-help`} className="thread-naming-note">
                {!validBranches
                  ? "Enter up to 20 branch names without spaces."
                  : "Separate exact branch names with commas. Add at least one to enable this rule."}
              </p>
            </div>
          )}
        </>
      )}
      <div className="completion-row">
        <div>
          <span>Pull request closed without merging</span>
          <p>Also finish threads whose linked PRs were abandoned.</p>
        </div>
        {toggle("closed", "Pull request closed without merging")}
      </div>
      {(preferences.merged || preferences.closed) && (
        <>
          <div className="completion-row">
            <span id={`${id}-requests`}>When a thread has multiple PRs</span>
            <SelectMenu
              value={preferences.pullRequests}
              label="When a thread has multiple PRs"
              labelledBy={`${id}-requests`}
              size="sm"
              className="w-52 shrink-0"
              options={[
                { value: "all", label: "All PRs match a rule" },
                { value: "any", label: "Any PR matches a rule" },
              ]}
              onChange={(pullRequests) =>
                change({ pullRequests: pullRequests as ThreadCompletion["pullRequests"] })
              }
            />
          </div>
          <p className="thread-naming-note">
            Checks PRs created in the thread. Unavailable PR status never counts as a match.
          </p>
        </>
      )}
      <div className="completion-row">
        <div>
          <span id={`${id}-inactive`}>No activity for</span>
          <p>Finish inactive threads, including threads without PRs.</p>
        </div>
        <SelectMenu
          value={String(preferences.inactiveDays)}
          label="No activity for"
          labelledBy={`${id}-inactive`}
          size="sm"
          className="w-52 shrink-0"
          options={[
            { value: "0", label: "Never" },
            ...[7, 14, 30, 90].map((days) => ({ value: String(days), label: `${days} days` })),
          ]}
          onChange={(days) =>
            change({ inactiveDays: Number(days) as ThreadCompletion["inactiveDays"] })
          }
        />
      </div>
      <p className="thread-naming-note">
        Running threads, queued messages, approvals, and failed or interrupted runs stay open.
        Reopening a thread ignores earlier PR events and restarts the inactivity clock.
      </p>
    </section>
  );
}
