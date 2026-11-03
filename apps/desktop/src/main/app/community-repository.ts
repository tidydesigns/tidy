import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import type { CommunityAPI } from "../../shared/contracts/community";

const execute = promisify(execFile);
const responseSchema = z.object({
  data: z.object({ repository: z.object({ viewerHasStarred: z.boolean() }) }),
});

async function run(args: string[]) {
  const { stdout } = await execute("gh", ["api", "--hostname", "github.com", ...args], {
    cwd: homedir(),
    timeout: 8000,
    maxBuffer: 16 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
  });
  return stdout;
}

export class CommunityRepository implements Pick<CommunityAPI, "status" | "star"> {
  constructor(private readonly request = run) {}

  async status(): ReturnType<CommunityAPI["status"]> {
    try {
      const output = await this.request([
        "graphql",
        "-f",
        'query={repository(owner:"tidydesigns",name:"tidy"){viewerHasStarred}}',
      ]);
      return responseSchema.parse(JSON.parse(output)).data.repository.viewerHasStarred
        ? "starred"
        : "unstarred";
    } catch {
      return "unavailable";
    }
  }

  async star() {
    try {
      await this.request(["--method", "PUT", "/user/starred/tidydesigns/tidy"]);
      return true;
    } catch {
      return false;
    }
  }
}
