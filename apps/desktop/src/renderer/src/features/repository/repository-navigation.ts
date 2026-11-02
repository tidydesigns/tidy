import { z } from "zod";
import type {
  RepositoryChange,
  RepositoryDirectory,
} from "../../../../shared/contracts/repository-files";

export const changeFolderExceptionLimit = 1024;
const changeFolderState = z.object({
  collapsed: z.boolean(),
  exceptions: z.array(z.string()).max(changeFolderExceptionLimit),
});
export const changeFolderSchema = z.union([
  changeFolderState,
  z
    .array(z.string())
    .max(64)
    .transform((exceptions) => ({ collapsed: false, exceptions })),
]);
export type ChangeFolderState = z.infer<typeof changeFolderState>;

export function expandedChangeFolders(paths: Iterable<string>, state: ChangeFolderState) {
  const exceptions = new Set(state.exceptions);
  return new Set([...paths].filter((path) => path && state.collapsed === exceptions.has(path)));
}

export function toggleChangeFolder(state: ChangeFolderState, path: string): ChangeFolderState {
  if (state.exceptions.includes(path))
    return { ...state, exceptions: state.exceptions.filter((entry) => entry !== path) };
  if (state.exceptions.length >= changeFolderExceptionLimit) return state;
  return { ...state, exceptions: [...state.exceptions, path] };
}

export function changedFileDirectories(changes: readonly RepositoryChange[]) {
  const directories = new Map<string, RepositoryDirectory>([["", { entries: [], limited: false }]]);
  const seen = new Set<string>();
  const files = new Set(changes.map((change) => change.path));
  if (
    changes.some((change) =>
      change.path
        .split("/")
        .slice(0, -1)
        .some((_, index, parts) => files.has(parts.slice(0, index + 1).join("/"))),
    )
  ) {
    directories.get("")?.entries.push(
      ...changes.map((change) => ({
        path: change.path,
        name: change.path,
        kind: "file" as const,
      })),
    );
    return directories;
  }
  for (const change of changes) {
    const parts = change.path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      const path = parts.slice(0, index + 1).join("/");
      const directory = directories.get(parent);
      if (!directory || seen.has(path)) continue;
      seen.add(path);
      const folder = index < parts.length - 1;
      directory.entries.push({ path, name: parts[index], kind: folder ? "directory" : "file" });
      if (folder) directories.set(path, { entries: [], limited: false });
    }
  }
  for (const directory of directories.values())
    directory.entries.sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name),
    );
  return directories;
}
