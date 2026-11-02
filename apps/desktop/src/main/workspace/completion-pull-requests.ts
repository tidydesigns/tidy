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
    super(async (url) => {
      const { stdout } = await readGitHub([
        "pr",
        "view",
        url,
        "--json",
        "state,isDraft,baseRefName,mergedAt,closedAt",
      ]);
      const value = responseSchema.parse(JSON.parse(stdout));
      if (value.state !== "MERGED")
        return {
          state: parsePullRequestState(value),
          baseBranch: value.baseRefName,
          defaultBranch: null,
          endedAt: value.closedAt,
        };
      const repository = new URL(url).pathname.split("/").slice(1, 3).join("/");
      let entry = repositories.get(repository);
      if (!entry || entry.expires < Date.now()) {
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
      return {
        state: parsePullRequestState(value),
        baseBranch: value.baseRefName,
        defaultBranch: await entry.result,
        endedAt: value.state === "MERGED" ? value.mergedAt : value.closedAt,
      };
    });
    this.clearRepositories = () => repositories.clear();
  }

  override invalidate() {
    super.invalidate();
    this.clearRepositories();
  }
}
