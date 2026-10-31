import type { ReactNode } from "react";
import { Icon } from "@tidy/editor/components/ui/icon";
import { ChatLink } from "../../components/chat-link";
import type { DesktopAPI, ThreadSummary } from "../../../../shared/contracts/desktop";
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
    <div className="grid min-w-0 max-w-full grid-cols-[12px_minmax(0,1fr)] items-start gap-2">
      <dt
        className="flex h-[18px] items-center text-muted-ink [&>:first-child]:size-3 [&>:first-child]:shrink-0"
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
  api,
  projectName,
  repository,
  modelName,
}: {
  thread: Pick<
    ThreadSummary,
    "title" | "harness" | "actualModel" | "settings" | "projectId" | "pullRequests"
  >;
  api?: Pick<DesktopAPI, "openChatLink" | "browser" | "pullRequestState">;
  projectName?: string;
  repository?: RepositoryContext;
  modelName?: string;
}) {
  return (
    <>
      <strong className="line-clamp-2 text-[13px] leading-[1.5] font-medium wrap-anywhere">
        {thread.title}
      </strong>
      <dl className="thread-preview-details mt-2 grid gap-1.5 text-xs leading-[1.5] text-secondary-ink">
        <Detail label="Model" icon={<ModelProviderIcon harness={thread.harness} size={12} />}>
          {modelName ?? thread.actualModel ?? thread.settings?.model ?? "Model not reported"}
        </Detail>
        {projectName && (
          <Detail label="Project" icon={<Icon name="folder" size={12} />}>
            {projectName}
          </Detail>
        )}
        {repository?.repository && (
          <Detail label="Branch" icon={<ComposerIcon name="branch" />}>
            {repository.branch ?? "Detached HEAD"}
          </Detail>
        )}
      </dl>
      {api && thread.pullRequests && thread.pullRequests.length > 0 && (
        <ul
          className="thread-preview-pull-requests mt-2 grid max-h-40 gap-0.5 overflow-y-auto overscroll-contain border-t border-border pt-2"
          aria-label="Thread pull requests"
        >
          {thread.pullRequests.map((url) => (
            <li key={url}>
              <ChatLink href={url} api={api} projectId={thread.projectId}>
                <span className="shrink-0 tabular-nums">{`#${url.split("/").at(-1)}`}</span>
                <span className="truncate text-secondary-ink">
                  {url.split("/").slice(3, 5).join("/")}
                </span>
              </ChatLink>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
