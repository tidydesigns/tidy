import { Icon } from "@tidy/editor/components/ui/icon";
import type { Project, ThreadSummary } from "../../../../shared/contracts/desktop";
import { harnessNames } from "../../../../shared/contracts/harness-updates";
import { ModelProviderIcon } from "../harnesses/model-provider-icon";
import { relativeThreadTime } from "../threads/thread-time";

export function ThreadResult({
  title,
  thread,
  project,
  machineLabel,
}: {
  title: string;
  thread: ThreadSummary;
  project: Project;
  machineLabel: string;
}) {
  const age = relativeThreadTime(thread.updatedAt, Date.now());
  const location = project.cloud ? "Cloud workspace" : machineLabel;
  const branch = thread.worktree?.branch;
  const provider = harnessNames[thread.harness];
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink">{title}</span>
        <span
          className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-ink"
          title={[project.name, location, branch, provider].filter(Boolean).join(" · ")}
        >
          <Icon name="folder" size={12} />
          <span className="max-w-[35%] truncate">{project.name}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{location}</span>
          {branch && (
            <>
              <span aria-hidden="true">·</span>
              <span className="max-w-[35%] truncate">{branch}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="shrink-0" role="img" aria-label={provider} title={provider}>
            <ModelProviderIcon harness={thread.harness} size={12} />
          </span>
        </span>
      </span>
      <time
        dateTime={thread.updatedAt}
        title={new Date(thread.updatedAt).toLocaleString()}
        className="shrink-0 text-[11px] tabular-nums text-muted-ink"
      >
        {age === "now" || !age ? age : `${age} ago`}
      </time>
    </>
  );
}
