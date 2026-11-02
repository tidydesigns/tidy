import { useEffect, useState } from "react";
import type { RepositorySearch } from "../../../../shared/contracts/repository-search";
import type { RepositoryAPI } from "./use-repository-files";
import { repositoryRead } from "./repository-read";

const emptyEntries: RepositorySearch["entries"] = [];

export function useRepositorySearch(
  api: RepositoryAPI,
  projectId: string,
  query: string,
  active: boolean,
  revision: number,
) {
  const needle = query.trim();
  const [state, setState] = useState<{
    query: string;
    result?: RepositorySearch;
    error?: string;
  }>({ query: "" });
  useEffect(() => {
    if (!active || !needle) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const search = api.repositorySearch;
      if (!search) {
        setState({
          query: needle,
          error: "File search needs a backend update. Reconnect and retry.",
        });
        return;
      }
      void repositoryRead(search(projectId, needle)).then(
        (result) => {
          if (!cancelled) setState({ query: needle, result });
        },
        (cause: unknown) => {
          if (!cancelled)
            setState({
              query: needle,
              error: cause instanceof Error ? cause.message : "Could not search files.",
            });
        },
      );
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, projectId, needle, active, revision]);
  const current = state.query === needle ? state : undefined;
  return {
    entries: current?.result?.entries ?? emptyEntries,
    limited: current?.result?.limited ?? false,
    pending: Boolean(active && needle && !current?.result && !current?.error),
    error: current?.error ?? "",
  };
}
