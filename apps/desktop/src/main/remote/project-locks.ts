import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { lockHost } from "./host-lock";

export function projectLocks(directory = join(homedir(), ".local", "state", "tidy-project-locks")) {
  const locks = new Map<string, () => void>();
  return {
    claim(path: string) {
      if (locks.has(path)) return;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const key = createHash("sha256").update(path).digest("hex");
      try {
        locks.set(path, lockHost(join(directory, key)));
      } catch {
        throw new Error(
          "This project is open in another Tidy backend. Close that workspace first.",
        );
      }
    },
    close() {
      for (const release of locks.values()) release();
      locks.clear();
    },
  };
}
