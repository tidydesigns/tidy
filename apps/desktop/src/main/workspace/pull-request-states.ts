import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { pullRequestURL, type PullRequestState } from "../../shared/contracts/pull-request";

const execute = promisify(execFile);
const responseSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
});

async function readState(url: string): Promise<PullRequestState> {
  const { stdout } = await execute("gh", ["pr", "view", url, "--json", "state,isDraft"], {
    timeout: 8000,
    maxBuffer: 16 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
  });
  return parsePullRequestState(JSON.parse(stdout));
}

export function parsePullRequestState(response: unknown): PullRequestState {
  const value = responseSchema.parse(response);
  if (value.state === "MERGED") return "merged";
  if (value.state === "CLOSED") return "closed";
  return value.isDraft ? "draft" : "open";
}

export class PullRequestStates {
  private readonly cache = new Map<
    string,
    { expires: number; pending: boolean; result: Promise<PullRequestState | null> }
  >();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly load: (url: string) => Promise<PullRequestState> = readState,
    private readonly now: () => number = Date.now,
  ) {}

  read(href: string): Promise<PullRequestState | null> {
    const url = pullRequestURL(href);
    if (!url) return Promise.resolve(null);
    const cached = this.cache.get(url);
    if (cached && (cached.pending || cached.expires > this.now())) return cached.result;
    this.cache.delete(url);
    if (this.cache.size >= 256) {
      const oldest = [...this.cache].find(([, entry]) => !entry.pending);
      if (!oldest) return Promise.resolve(null);
      this.cache.delete(oldest[0]);
    }
    const entry = {
      expires: Infinity,
      pending: true,
      result: Promise.resolve<PullRequestState | null>(null),
    };
    entry.result = this.lookup(url).then((state) => {
      entry.pending = false;
      entry.expires = this.now() + (state === null ? 15_000 : 60_000);
      return state;
    });
    this.cache.set(url, entry);
    return entry.result;
  }

  private async lookup(url: string): Promise<PullRequestState | null> {
    if (this.active >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await this.load(url);
    } catch {
      return null;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
