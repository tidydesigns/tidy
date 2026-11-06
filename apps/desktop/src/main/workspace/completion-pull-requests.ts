import { z } from "zod";
import { readGitHub } from "./github-read";
import { CachedPullRequests, parsePullRequestState } from "./pull-request-states";
import type { CompletionPullRequest } from "../../shared/contracts/thread-completion";

const responseSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  baseRefName: z.string().min(1).max(1024),
  mergedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
});
const repositorySchema = z.object({
  defaultBranchRef: z.object({ name: z.string().min(1) }).nullable(),
});

/** Only canonical GitHub PR URLs reach this loader. No shell or repository scripts execute. */
export class CompletionPullRequests extends CachedPullRequests<CompletionPullRequest> {
  private readonly clearRepositories: () => void;
  constructor() {
    const repositories = new Map<string, { expires: number; result: Promise<string | null> }>();
    const merged = new Map<string, z.infer<typeof responseSchema>>();
    super(async (url) => {
      let value = merged.get(url);
      if (!value) {
        const { stdout } = await readGitHub([
          "pr",
          "view",
          url,
          "--json",
          "state,isDraft,baseRefName,mergedAt,closedAt",
        ]);
        value = responseSchema.parse(JSON.parse(stdout));
        // Merge state is immutable. Repository defaults remain separately refreshable.
        if (value.state === "MERGED") {
          if (merged.size >= 256) merged.delete(merged.keys().next().value!);
          merged.set(url, value);
        }
      }
      if (value.state !== "MERGED")
        return {
          state: parsePullRequestState(value),
          baseBranch: value.baseRefName,
          defaultBranch: null,
          endedAt: value.closedAt,
        };
      const repository = new URL(url).pathname.split("/").slice(1, 3).join("/");
      let entry = repositories.get(repository);
      if (!entry || entry.expires <= Date.now()) {
        const result = readGitHub([
          "repo",
          "view",
          `https://github.com/${repository}`,
          "--json",
          "defaultBranchRef",
        ])
          .then(
            ({ stdout }) =>
              repositorySchema.parse(JSON.parse(stdout)).defaultBranchRef?.name ?? null,
          )
          .catch(() => null);
        entry = { result, expires: Date.now() + 60_000 };
        if (repositories.size >= 256) repositories.delete(repositories.keys().next().value!);
        repositories.set(repository, entry);
      }
      const defaultBranch = await entry.result;
      if (defaultBranch === null) entry.expires = 0;
      return {
        state: parsePullRequestState(value),
        baseBranch: value.baseRefName,
        defaultBranch,
        endedAt: value.mergedAt,
      };
    }, Date.now);
    this.clearRepositories = () => repositories.clear();
  }

  override invalidate() {
    super.invalidate();
    this.clearRepositories();
  }
}
