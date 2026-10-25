import type { ReactNode } from "react";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { ThreadSummary } from "../../shared/contracts";
import type { RepositoryContext } from "../../shared/repository-context";
import { ComposerIcon, ModelProviderIcon } from "./composer-icon";

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
    <div>
      <dt aria-label={label}>{icon}</dt>
      <dd>{children}</dd>
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
      <strong>{thread.title}</strong>
      <dl className="thread-preview-details">
        <Detail label="Model" icon={<ModelProviderIcon harness={thread.harness} />}>
          {modelName ?? thread.actualModel ?? thread.settings?.model ?? "Model not reported"}
        </Detail>
      </dl>
      {(projectName || repository?.repository) && (
        <dl className="thread-preview-context">
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
