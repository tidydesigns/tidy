import { useId, useState } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import {
  worktreePreferencesSchema,
  type WorktreePreferences,
} from "../../../../shared/contracts/worktree-settings";
import { worktreeNames } from "../../../../shared/models/worktree-names";
import {
  changeWorktreePreferences,
  loadWorktreePreferences,
  useWorktreePreferences,
  useWorktreeStorage,
  refreshWorktreeStorage,
  removeStoredWorktree,
} from "./worktree-preferences";

function PreferencesError({ error }: { error: string }) {
  return error ? (
    <div className="completion-row" role="alert">
      <p>{error}</p>
      <Button className="quiet-button" onClick={() => void loadWorktreePreferences()}>
        Retry
      </Button>
    </div>
  ) : null;
}
export function WorktreeNamingSettings({ active }: { active: boolean }) {
  const { preferences, ready, error } = useWorktreePreferences(active);
  const [prefixDraft, setPrefixDraft] = useState<string>();
  const id = useId();
  const prefix = prefixDraft ?? preferences.branchPrefix;
  const valid = worktreePreferencesSchema.shape.branchPrefix.safeParse(prefix).success;
  const example = worktreeNames(
    "a31f89c2-5640-4ed1-b8f5-0a62c0d0a032",
    { ...preferences, branchPrefix: valid ? prefix : preferences.branchPrefix },
    "Add storage settings",
  );
  return (
    <section className="thread-completion-settings" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Worktree naming</h2>
      <PreferencesError error={error} />
      <div className="completion-row">
        <span id={`${id}-naming`}>Folder and branch names</span>
        <SelectMenu
          value={preferences.naming}
          label="Worktree names"
          labelledBy={`${id}-naming`}
          disabled={!ready}
          size="sm"
          className="w-48 shrink-0"
          options={[
            { value: "uuid", label: "UUID (default)" },
            { value: "prompt", label: "First message + short ID" },
          ]}
          onChange={(naming) =>
            changeWorktreePreferences({ naming: naming as WorktreePreferences["naming"] })
          }
        />
      </div>
      <div className="completion-row">
        <label htmlFor={`${id}-prefix`}>Branch prefix</label>
        <input
          id={`${id}-prefix`}
          className="worktree-prefix"
          value={prefix}
          maxLength={60}
          disabled={!ready}
          aria-invalid={!valid}
          aria-describedby={`${id}-prefix-note`}
          onChange={(event) => {
            const value = event.target.value;
            setPrefixDraft(value);
          }}
          onBlur={() => {
            if (valid) {
              if (prefix !== preferences.branchPrefix)
                changeWorktreePreferences({ branchPrefix: prefix });
              setPrefixDraft(undefined);
            }
          }}
        />
      </div>
      <p id={`${id}-prefix-note`} className="thread-naming-note">
        {valid
          ? "Use lowercase letters, numbers and hyphens; end with / or -."
          : "Enter a prefix such as feat/tidy-, feat/ or fix/."}
      </p>
      <div className="worktree-example">
        <span>Branch preview</span>
        <code>{example.branch}</code>
        <span>Folder preview</span>
        <code>{example.name}</code>
      </div>
      <p className="thread-naming-note">
        Applies to new worktrees on this machine. Existing branches and folders keep their names.
        First-message names stay fixed when a thread is renamed.
      </p>
    </section>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
export function WorktreeStorageSettings({ active }: { active: boolean }) {
  const { preferences, ready, error } = useWorktreePreferences(active);
  const storage = useWorktreeStorage(active);
  const [confirm, setConfirm] = useState<string>();
  const id = useId();
  function toggle(key: "deleteWithThread" | "deleteMerged" | "deleteUnchanged", label: string) {
    return (
      <Button
        className="completion-switch"
        role="switch"
        aria-label={label}
        aria-checked={preferences[key]}
        disabled={!ready}
        onClick={() => changeWorktreePreferences({ [key]: !preferences[key] })}
      >
        <span />
      </Button>
    );
  }
  return (
    <section aria-label="Worktree storage">
      <PreferencesError error={error} />
      <p className="thread-naming-note">
        Manage worktrees on this machine. Cleanup runs every 15 minutes while Tidy is open. Rules
        are off by default.
      </p>
      <div className="worktree-cleanup-rows">
        <div className="completion-row">
          <div>
            <span>Delete worktrees with deleted threads</span>
            <p>Remove unused worktrees after their threads are deleted.</p>
          </div>
          {toggle("deleteWithThread", "Delete worktrees with deleted threads")}
        </div>
        <div className="completion-row">
          <div>
            <span id={`${id}-inactive`}>Delete inactive worktrees</span>
            <p>Remove worktrees after their threads have been inactive for this many days.</p>
          </div>
          <SelectMenu
            value={String(preferences.inactiveDays)}
            label="Delete inactive worktrees"
            labelledBy={`${id}-inactive`}
            disabled={!ready}
            size="sm"
            className="w-32 shrink-0"
            options={[
              { value: "0", label: "Never" },
              ...[7, 14, 30, 90].map((value) => ({ value: String(value), label: `${value} days` })),
            ]}
            onChange={(days) =>
              changeWorktreePreferences({
                inactiveDays: Number(days) as WorktreePreferences["inactiveDays"],
              })
            }
          />
        </div>
        <div className="completion-row">
          <div>
            <span>Delete merged worktrees</span>
            <p>
              Remove worktrees whose linked PRs are merged and whose commits are included in the
              default branch.
            </p>
          </div>
          {toggle("deleteMerged", "Delete merged worktrees")}
        </div>
        <div className="completion-row">
          <div>
            <span>Delete unchanged worktrees</span>
            <p>Remove worktrees with no commits beyond the default branch.</p>
          </div>
          {toggle("deleteUnchanged", "Delete unchanged worktrees")}
        </div>
      </div>
      <p className="thread-naming-note">
        Branches and thread history are kept. Worktrees with local changes, including ignored files,
        or active work are kept. Cleanup uses local Git history and skips default-branch rules when
        that branch is unknown.
      </p>
      <div className="completion-row">
        <div>
          <span>Worktrees</span>
          <p role="status">
            {storage.ready
              ? `${storage.entries.length} ${storage.entries.length === 1 ? "worktree" : "worktrees"} · ${formatBytes(storage.entries.reduce((sum, entry) => sum + entry.bytes, 0))}`
              : storage.loading
                ? "Calculating usage…"
                : "Usage unavailable"}
          </p>
        </div>
        <Button
          className="quiet-button"
          disabled={storage.loading}
          onClick={() => void refreshWorktreeStorage()}
        >
          {storage.loading && storage.ready ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {storage.error && (
        <p className="thread-naming-note" role="alert">
          {storage.error}
        </p>
      )}
      {storage.entries.length > 0 && (
        <details className="worktree-inventory">
          <summary>Manage worktrees</summary>
          <div className="worktree-inventory-list">
            {storage.entries.map((entry) => (
              <div className="worktree-entry" key={entry.id}>
                <div>
                  <strong>{entry.title}</strong>
                  <p>
                    {entry.projectName} · {formatBytes(entry.bytes)}
                  </p>
                  <code>{entry.branch}</code>
                  <p className="worktree-path">{entry.path}</p>
                  {(entry.busy || entry.hasChanges) && (
                    <p>{entry.busy ? "In use" : "Contains local or ignored files"}</p>
                  )}
                </div>
                <div className="worktree-entry-actions">
                  {confirm === entry.id ? (
                    <>
                      <span>
                        Remove checkout? Branch and history stay. Restore it to run this thread
                        again.
                      </span>
                      <Button
                        className="quiet-button"
                        aria-label={`Confirm removal of ${entry.title}`}
                        onClick={() => {
                          setConfirm(undefined);
                          void removeStoredWorktree(entry);
                        }}
                      >
                        Remove checkout
                      </Button>
                      <Button className="quiet-button" onClick={() => setConfirm(undefined)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      className="quiet-button"
                      aria-label={`Remove worktree for ${entry.title}`}
                      disabled={entry.busy || entry.hasChanges}
                      onClick={() => setConfirm(entry.id)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
