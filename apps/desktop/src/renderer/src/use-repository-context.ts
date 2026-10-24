import { useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../shared/contracts";
import type { RepositoryContext } from "../../shared/repository-context";

type RepositoryEntry =
  | { kind: "ready"; context: RepositoryContext }
  | { kind: "switching"; context: RepositoryContext };

export function useRepositoryContext({
  api,
  projectId,
  onError,
}: {
  api?: Pick<DesktopAPI, "repositoryContext" | "switchBranch">;
  projectId?: string;
  onError(error: { projectId: string; cause: unknown }): void;
}) {
  const [entries, setEntries] = useState<Partial<Record<string, RepositoryEntry>>>({});
  const requests = useRef(new Map<string, number>());
  const switches = useRef(new Set<string>());
  const entry = projectId ? entries[projectId] : undefined;
  const switching = entry?.kind === "switching";

  useEffect(() => {
    if (!api || !projectId || switching) return;
    let disposed = false;
    async function refresh() {
      if (!api || !projectId || switches.current.has(projectId)) return;
      const version = (requests.current.get(projectId) ?? 0) + 1;
      requests.current.set(projectId, version);
      try {
        const context = await api.repositoryContext(projectId);
        if (!disposed && requests.current.get(projectId) === version)
          setEntries((current) => ({ ...current, [projectId]: { kind: "ready", context } }));
      } catch (cause) {
        if (!disposed && requests.current.get(projectId) === version) onError({ projectId, cause });
      }
    }
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [api, projectId, switching, onError]);

  async function switchBranch(branch: string) {
    const previous = entry?.context;
    if (
      !api ||
      !projectId ||
      switches.current.has(projectId) ||
      !previous?.repository ||
      previous.branch === branch ||
      !previous.branches.includes(branch)
    )
      return;
    switches.current.add(projectId);
    requests.current.set(projectId, (requests.current.get(projectId) ?? 0) + 1);
    setEntries((current) => ({
      ...current,
      [projectId]: { kind: "switching", context: { ...previous, branch } },
    }));
    try {
      const context = await api.switchBranch(projectId, branch);
      setEntries((current) => ({ ...current, [projectId]: { kind: "ready", context } }));
    } catch (cause) {
      setEntries((current) => ({
        ...current,
        [projectId]: { kind: "ready", context: previous },
      }));
      onError({ projectId, cause });
    } finally {
      switches.current.delete(projectId);
    }
  }

  return { repository: entry?.context, switching, switchBranch };
}
