import { useId, useSyncExternalStore } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import { showToast } from "@tidy/ui/toast";
import type { ThreadNaming } from "../../../../shared/contracts/thread-naming";
import {
  currentThreadNaming,
  selectThreadNaming,
  subscribeThreadNaming,
} from "./thread-naming-preferences";

export function ThreadNamingSettings() {
  const naming = useSyncExternalStore(subscribeThreadNaming, currentThreadNaming);
  const id = useId();
  function change(patch: Partial<ThreadNaming>) {
    if (!selectThreadNaming({ ...currentThreadNaming(), ...patch }))
      showToast("Naming preferences changed for this session, but could not be remembered.");
  }
  return (
    <div className="thread-naming-settings">
      <div className="settings-appearance-row">
        <span id={`${id}-mode`}>New thread names</span>
        <SelectMenu
          value={naming.mode}
          label="New thread names"
          labelledBy={`${id}-mode`}
          size="sm"
          className="w-44 shrink-0"
          options={[
            { value: "automatic", label: "Automatic" },
            { value: "prompt", label: "First message" },
          ]}
          onChange={(mode) => change({ mode: mode as ThreadNaming["mode"] })}
        />
      </div>
      <p className="thread-naming-note">
        Applies to new threads. You can rename any thread by double-clicking its heading.
      </p>
      <div className="settings-appearance-row">
        <span id={`${id}-provider`}>Naming provider</span>
        <SelectMenu
          value={naming.provider}
          label="Naming provider"
          labelledBy={`${id}-provider`}
          size="sm"
          className="w-44 shrink-0"
          options={[
            { value: "thread", label: "Same as thread" },
            { value: "codex", label: "Codex" },
            { value: "claude", label: "Claude Code" },
            { value: "opencode", label: "OpenCode" },
          ]}
          onChange={(provider) => change({ provider: provider as ThreadNaming["provider"] })}
        />
      </div>
      <p className="thread-naming-note">
        Uses the selected agent’s existing sign-in and inference allowance. It must be installed on
        the machine running the thread.
      </p>
      <label className="thread-naming-instructions" htmlFor={`${id}-instructions`}>
        Naming instructions <span className="text-muted-ink">(optional)</span>
      </label>
      <textarea
        id={`${id}-instructions`}
        value={naming.instructions}
        maxLength={1000}
        rows={3}
        className="thread-naming-textarea"
        placeholder="Short task names, sentence case, no emoji"
        onChange={(event) => change({ instructions: event.target.value })}
      />
    </div>
  );
}
