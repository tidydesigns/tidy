import type { ReactNode } from "react";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { ThreadSummary } from "../../../../shared/contracts/desktop";
import type { RepositoryContext } from "../../../../shared/contracts/repository-context";
import { ComposerIcon } from "../composer/composer-icon";
import { ModelProviderIcon } from "../harnesses/model-provider-icon";

function Detail({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 max-w-full grid-cols-[14px_minmax(0,1fr)] items-start gap-2">
      <dt
        className="flex h-[18px] items-center text-muted-ink [&>:first-child]:size-3.5 [&>:first-child]:shrink-0"
        aria-label={label}
      >
        {icon}
      </dt>
      <dd className="m-0 min-w-0 wrap-anywhere">{children}</dd>
    </div>
  );
}

export function ThreadPreview({
  thread,
  projectName,
  repository,
  modelName,
}: {
  thread: Pick<ThreadSummary, "title" | "harness" | "actualModel" | "settings">;
  projectName?: string;
  repository?: RepositoryContext;
  modelName?: string;
}) {
  return (
    <>
      <strong className="line-clamp-2 text-sm leading-[1.5] font-medium wrap-anywhere">
        {thread.title}
      </strong>
      <dl className="thread-preview-details mt-3 text-xs leading-[1.5] text-secondary-ink">
        <Detail label="Model" icon={<ModelProviderIcon harness={thread.harness} />}>
          {modelName ?? thread.actualModel ?? thread.settings?.model ?? "Model not reported"}
        </Detail>
      </dl>
      {(projectName || repository?.repository) && (
        <dl className="thread-preview-context mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] leading-[1.5] text-muted-ink">
          {projectName && (
            <Detail label="Project" icon={<Icon name="folder" size={14} />}>
              {projectName}
            </Detail>
          )}
          {repository?.repository && (
            <Detail label="Branch" icon={<ComposerIcon name="branch" />}>
              {repository.branch ?? "Detached HEAD"}
            </Detail>
          )}
        </dl>
      )}
    </>
  );
}
