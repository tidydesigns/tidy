import { z } from "zod";

const threadsKey = "tidy:community:threads";
const dismissedKey = "tidy:community:dismissed";
const threadsSchema = z.array(z.uuid()).max(5);

export class CommunityProgress {
  private readonly listeners = new Set<() => void>();
  private dismissed = false;

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">) {}

  get suppressed() {
    try {
      return this.dismissed || this.storage.getItem(dismissedKey) === "true";
    } catch {
      return true;
    }
  }

  get eligible() {
    try {
      if (this.suppressed) return false;
      const threads = threadsSchema.parse(JSON.parse(this.storage.getItem(threadsKey) ?? "[]"));
      if (new Set(threads).size < 5) return false;
      this.storage.setItem(threadsKey, JSON.stringify(threads));
      return true;
    } catch {
      return false;
    }
  }

  record(threadId: string) {
    try {
      if (this.suppressed || !z.uuid().safeParse(threadId).success) return;
      const threads = threadsSchema.parse(JSON.parse(this.storage.getItem(threadsKey) ?? "[]"));
      if (threads.length === 5 || threads.includes(threadId)) return;
      this.storage.setItem(threadsKey, JSON.stringify([...threads, threadId]));
      for (const listener of this.listeners) listener();
    } catch {}
  }

  suppress() {
    this.dismissed = true;
    try {
      this.storage.setItem(dismissedKey, "true");
    } catch {}
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

let progress: CommunityProgress | undefined;
export function communityProgress() {
  try {
    return (progress ??= new CommunityProgress(localStorage));
  } catch {
    return undefined;
  }
}

export function recordCommunityThreadStarted(threadId: string) {
  communityProgress()?.record(threadId);
}
