import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform === "win32")(
  "desktop PR state and merge completion find gh outside the inherited PATH",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "tidy gh discovery "));
    try {
      const bin = join(directory, ".local/bin");
      const system = join(directory, "system-bin");
      const log = join(directory, "calls.log");
      await mkdir(bin, { recursive: true });
      await mkdir(system);
      await writeFile(
        join(bin, "gh"),
        `#!/bin/sh
[ "$GH_TOKEN" = "disposable-gh-fixture" ] || exit 70
[ "$GH_CONFIG_DIR" = "$HOME/gh-config" ] || exit 71
[ "$GH_PROMPT_DISABLED" = "1" ] || exit 72
[ "$GH_PAGER" = "cat" ] || exit 73
printf '%s\\n' "$1 $2" >> "$TIDY_GH_FIXTURE_LOG"
case "$1 $2" in
  "pr view") printf '%s\\n' '{"state":"MERGED","isDraft":false,"baseRefName":"main","mergedAt":"2026-01-01T00:00:00Z","closedAt":"2026-01-01T00:00:00Z"}' ;;
  "repo view") printf '%s\\n' '{"defaultBranchRef":{"name":"main"}}' ;;
  *) exit 74 ;;
esac
`,
        { mode: 0o700 },
      );
      const moduleURL = (relative: string) =>
        JSON.stringify(new URL(relative, import.meta.url).href);
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { CompletionPullRequests } from ${moduleURL("./completion-pull-requests.ts")};
import { PullRequestStates } from ${moduleURL("./pull-request-states.ts")};
import { threadCompletionReason } from ${moduleURL("../../shared/models/thread-completion.ts")};
import { defaultThreadCompletion } from ${moduleURL("../../shared/contracts/thread-completion.ts")};
const url = "https://github.com/owner/repo/pull/42";
const requests = new CompletionPullRequests();
const merged = await requests.read(url);
const cached = await requests.read(url);
const state = await new PullRequestStates().read(url);
console.log(JSON.stringify({merged,cached,state,reason:threadCompletionReason({updatedAt:"2026-01-01T00:00:00Z"},defaultThreadCompletion,[merged])}));`,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            HOME: directory,
            PATH: system,
            GH_CONFIG_DIR: join(directory, "gh-config"),
            GH_TOKEN: "disposable-gh-fixture",
            TIDY_GH_FIXTURE_LOG: log,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const result = JSON.parse(stdout);
      expect(result.merged).toEqual({
        state: "merged",
        baseBranch: "main",
        defaultBranch: "main",
        endedAt: "2026-01-01T00:00:00Z",
      });
      expect(result.cached).toEqual(result.merged);
      expect(result.state).toBe("merged");
      expect(result.reason).toBe("merged");
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "pr view",
        "repo view",
        "pr view",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
