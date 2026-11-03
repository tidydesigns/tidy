import { createContext } from "react";
import { parseChatLink } from "../../../../shared/models/chat-links";
import type { RepositoryFile } from "../../../../shared/contracts/repository-files";
import type { RepositoryAPI } from "./use-repository-files";
import { repositoryRead } from "./repository-read";

type Entry<T> = { promise: Promise<T>; expires: number; bytes: number; stale: boolean };
export type FilePrefetch = ReturnType<typeof createFilePrefetch>;
export const FilePrefetchContext = createContext<FilePrefetch | null>(null);

export function createFilePrefetch({
  api,
  projectId,
  enabled = () => true,
  prepare,
}: {
  api: RepositoryAPI;
  projectId: string;
  enabled?: () => boolean;
  prepare?: () => Promise<unknown>;
}) {
  const links = new Map<string, Entry<string>>();
  const files = new Map<string, Entry<RepositoryFile>>();
  const lifetime = 2000;
  let active = 0;
  let generation = 0;
  let disposal = 0;
  let unsubscribe: (() => void) | undefined;
  let preparing: Promise<unknown> | undefined;
  function activate() {
    unsubscribe ??= api.onEvent((event) => {
      if (event.type === "repository-change" && event.projectId === projectId)
        invalidate([event.path]);
    });
  }
  function prune<T>(cache: Map<string, Entry<T>>) {
    const now = Date.now();
    for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
    let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of cache) {
      if (cache.size <= 6 && bytes <= 4 * 1024 * 1024) break;
      cache.delete(key);
      bytes -= entry.bytes;
    }
  }
  function resolve(href: string) {
    activate();
    const link = parseChatLink(href);
    const key = link?.kind === "file" ? link.path : href;
    prune(links);
    const cached = links.get(key);
    if (cached) return cached.promise;
    const resolveLink = api.resolveRepositoryLink;
    if (!resolveLink) return Promise.reject(new Error("Update this machine to open file links."));
    const entry: Entry<string> = {
      promise: repositoryRead(Promise.resolve().then(() => resolveLink(projectId, href))),
      expires: Infinity,
      bytes: 0,
      stale: false,
    };
    links.set(key, entry);
    void entry.promise.then(
      () => {
        entry.expires = Date.now() + lifetime;
        prune(links);
      },
      () => {
        if (links.get(key) === entry) links.delete(key);
      },
    );
    prune(links);
    return entry.promise;
  }
  function read(path: string, previousPath?: string, retries = 1): Promise<RepositoryFile> {
    activate();
    prune(files);
    const cached = files.get(path);
    if (cached) return cached.promise;
    const owner = disposal;
    const entry: Entry<RepositoryFile> = {
      promise: repositoryRead(
        Promise.resolve().then(() => api.repositoryFile(projectId, path, previousPath, "file")),
      ).then((file) => {
        if (!entry.stale) return file;
        if (owner !== disposal) throw new Error("File opening was cancelled.");
        if (!retries) throw new Error("This file changed while opening. Try again.");
        return read(path, previousPath, retries - 1);
      }),
      expires: Infinity,
      bytes: 0,
      stale: false,
    };
    files.set(path, entry);
    void entry.promise.then(
      (file) => {
        if (files.get(path) !== entry) return;
        if (file.kind !== "text") {
          files.delete(path);
          return;
        }
        entry.expires = Date.now() + lifetime;
        entry.bytes = file.text.length * 2;
        prune(files);
      },
      () => {
        if (files.get(path) === entry) files.delete(path);
      },
    );
    prune(files);
    return entry.promise;
  }
  function invalidate(paths?: readonly string[]) {
    generation++;
    links.clear();
    for (const [path, entry] of files)
      if (
        !paths ||
        paths.some((parent) => !parent || path === parent || path.startsWith(`${parent}/`))
      ) {
        entry.stale = true;
        files.delete(path);
      }
  }
  return {
    resolve,
    read,
    invalidate,
    prefetch(href: string) {
      if (!enabled() || active >= 2 || !api.resolveRepositoryLink) return;
      const link = parseChatLink(href);
      if (link?.kind !== "file") return;
      if (!preparing && prepare) {
        const pending = Promise.resolve().then(prepare);
        preparing = pending;
        void pending.catch(() => {
          if (preparing === pending) preparing = undefined;
        });
      }
      const current = generation;
      active++;
      void resolve(href)
        .then((path) => {
          if (current === generation && enabled()) return read(path);
        })
        .catch(() => {})
        .finally(() => active--);
    },
    dispose() {
      disposal++;
      unsubscribe?.();
      unsubscribe = undefined;
      preparing = undefined;
      invalidate();
    },
  };
}
