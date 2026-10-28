import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { lockHost } from "./host-lock";

export function projectLocks(directory = join(homedir(), ".local", "state", "tidy-project-locks")) {
  const locks = new Map<string, { references: number; release(): void }>();
  return {
    claim(path: string) {
      let lock = locks.get(path);
      if (!lock) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const key = createHash("sha256").update(path).digest("hex");
        try {
          lock = { references: 0, release: lockHost(join(directory, key)) };
          locks.set(path, lock);
        } catch {
          throw new Error(
            "This project is open in another Tidy backend. Close that workspace first.",
          );
        }
      }
      lock.references++;
      const claimed = lock;
      let released = false;
      return () => {
        if (released || locks.get(path) !== claimed) return;
        released = true;
        if (--claimed.references === 0) {
          claimed.release();
          locks.delete(path);
        }
      };
    },
    close() {
      for (const lock of locks.values()) lock.release();
      locks.clear();
    },
  };
}
