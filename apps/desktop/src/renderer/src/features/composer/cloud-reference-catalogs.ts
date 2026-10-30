import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { errorMessage } from "@tidy/ui/errors";
import type { CloudAPI, CloudAccount, CloudCatalog } from "../../../../shared/contracts/cloud-sync";

export type ReferenceCatalog =
  | { kind: "loading" }
  | { kind: "ready"; catalog: CloudCatalog; error?: string }
  | { kind: "error"; message: string };

export class CloudReferenceCatalogs {
  private value: Record<string, ReferenceCatalog> = {};
  private listeners = new Set<() => void>();
  private pending = new Set<string>();
  private queue: string[] = [];
  private active = 0;
  private fetchedAt = new Map<string, number>();
  constructor(
    private api: Pick<CloudAPI, "catalog">,
    private isCurrent: () => boolean,
  ) {}
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(id: string, catalog: ReferenceCatalog) {
    if (!this.isCurrent()) return;
    this.value = { ...this.value, [id]: catalog };
    for (const listener of this.listeners) listener();
  }
  load = (id: string, refresh = false) => {
    if (!this.isCurrent() || this.pending.has(id) || (!refresh && this.value[id])) return;
    this.pending.add(id);
    if (this.value[id]?.kind !== "ready") this.publish(id, { kind: "loading" });
    this.queue.push(id);
    this.pump();
  };
  refresh(id: string) {
    const fetched = this.fetchedAt.get(id);
    if (fetched !== undefined && Date.now() - fetched < 30_000) return;
    this.load(id, true);
  }
  private pump() {
    while (this.active < 4 && this.queue.length) {
      const id = this.queue.shift();
      if (!id) return;
      if (!this.isCurrent()) {
        this.pending.delete(id);
        continue;
      }
      this.active++;
      void this.read(id).finally(() => {
        this.active--;
        this.pending.delete(id);
        this.pump();
      });
    }
  }
  private async read(id: string) {
    if (this.value[id]?.kind !== "ready") {
      try {
        const catalog = await this.api.catalog(id, true);
        this.publish(id, { kind: "ready", catalog });
      } catch {}
    }
    if (!this.isCurrent()) return;
    try {
      const catalog = await this.api.catalog(id);
      this.fetchedAt.set(id, Date.now());
      this.publish(id, { kind: "ready", catalog });
    } catch (cause) {
      const message = errorMessage(cause, "Could not load designs. Try again.");
      const previous = this.value[id];
      this.publish(
        id,
        previous?.kind === "ready" ? { ...previous, error: message } : { kind: "error", message },
      );
    }
  }
}

export function useCloudReferenceCatalogs(
  api: CloudAPI | undefined,
  account: CloudAccount | undefined,
) {
  const accountId = account?.id;
  const current = useRef(accountId);
  current.current = accountId;
  const library = useMemo(
    () =>
      api && accountId
        ? new CloudReferenceCatalogs(api, () => current.current === accountId)
        : undefined,
    [api, accountId],
  );
  const catalogs = useSyncExternalStore(
    library?.subscribe ?? subscribeEmpty,
    library?.snapshot ?? snapshotEmpty,
  );
  useEffect(() => {
    for (const organization of account?.organizations ?? []) library?.load(organization.id);
  }, [library, account]);
  return {
    accountId,
    workspaces: (account?.organizations ?? []).map((organization) => ({
      ...organization,
      catalog: catalogs[organization.id] ?? { kind: "loading" as const },
    })),
    retry: (id: string) => library?.load(id, true),
    refresh: () => {
      for (const organization of account?.organizations ?? []) library?.refresh(organization.id);
    },
  };
}
const empty: Record<string, ReferenceCatalog> = {};
const subscribeEmpty = () => () => {};
const snapshotEmpty = () => empty;
export type CloudReferenceLibrary = ReturnType<typeof useCloudReferenceCatalogs>;
