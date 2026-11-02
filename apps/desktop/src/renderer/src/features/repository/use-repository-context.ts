import { branchSwitchContext } from "../../app/workspace-error";
import { UserFacingError } from "@tidy/ui/errors";
import { branchSwitchMessages } from "../../../../shared/contracts/repository-context";
import { useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import type { RepositoryContext } from "../../../../shared/contracts/repository-context";

type RepositoryEntry =
  | { kind: "ready"; context: RepositoryContext }
  | { kind: "switching"; context: RepositoryContext };

export function useRepositoryContext({
  api,
  projectId,
  threadId,
  onError,
}: {
  api?: Pick<DesktopAPI, "repositoryContext" | "switchBranch">;
  projectId?: string;
  threadId?: string;
  onError(error: { projectId: string; cause: unknown }): void;
}) {
  const [entries, setEntries] = useState<Partial<Record<string, RepositoryEntry>>>({});
  const requests = useRef(new Map<string, number>());
  const switches = useRef(new Set<string>());
  const key = `${projectId ?? ""}:${threadId ?? ""}`;
  const entry = projectId ? entries[key] : undefined;
  const switching = entry?.kind === "switching";

  useEffect(() => {
    if (!api || !projectId || switching) return;
    let disposed = false;
    async function refresh() {
      if (!api || !projectId || switches.current.has(projectId)) return;
      const version = (requests.current.get(key) ?? 0) + 1;
      requests.current.set(key, version);
      try {
        const context = await api.repositoryContext(projectId, threadId);
        if (!disposed && requests.current.get(key) === version)
          setEntries((current) => ({ ...current, [key]: { kind: "ready", context } }));
      } catch (cause) {
        if (!disposed && requests.current.get(key) === version) onError({ projectId, cause });
      }
    }
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [api, projectId, threadId, key, switching, onError]);

  async function switchBranch(branch: string) {
    const previous = entry?.context;
    if (
      !api ||
      !!threadId ||
      !projectId ||
      switches.current.has(projectId) ||
      !previous?.repository ||
      previous.branch === branch ||
      !previous.branches.includes(branch)
    )
      return;
    switches.current.add(projectId);
    requests.current.set(key, (requests.current.get(key) ?? 0) + 1);
    setEntries((current) => ({
      ...current,
      [key]: { kind: "switching", context: { ...previous, branch } },
    }));
    try {
      const context = branchSwitchContext(await api.switchBranch(projectId, branch));
      setEntries((current) => ({ ...current, [key]: { kind: "ready", context } }));
    } catch (cause) {
      setEntries((current) => ({
        ...current,
        [key]: { kind: "ready", context: previous },
      }));
      onError({
        projectId,
        cause:
          cause instanceof UserFacingError
            ? cause
            : new UserFacingError(branchSwitchMessages.failed, { cause }),
      });
    } finally {
      switches.current.delete(projectId);
    }
  }

  return { repository: entry?.context, switching, switchBranch };
}
