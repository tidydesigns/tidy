import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("GitHub JSON, status and tool errors expose only typed public messages with correct retry/status handling", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import {mock,expect} from "bun:test";
    mock.module("server-only",()=>({}));
    mock.module("@/lib/auth",()=>({auth:{api:{getSession:async()=>null}}}));
    const {apiError}=await import("./lib/github/http.ts");
    const {publicGitHubMessage}=await import("./lib/github/public-error.ts");
    const {GitHubRequestError}=await import("./lib/github/request-error.ts");
    const {GitHubError}=await import("./lib/github/client.ts");
    const {OrganizationAccessError}=await import("./lib/organizations/access-error.ts");
    const {MutationBudgetError}=await import("./lib/security/mutation-budget.ts");
    const {ImageCapacityError}=await import("./lib/design/image-capacity.ts");
    const {ImageBudgetUnavailableError}=await import("./lib/design/image-budget.ts");
    const {GitHubHistoryLimitError}=await import("./lib/github/history-limits.ts");
    const {GitHubWorkLimitError}=await import("./lib/github/work-budget.ts");
    const {RequestBodyError}=await import("./lib/http/request-body.ts");
    const {z}=await import("zod");
    for(const error of [new Error("private token abc and SQL values"),Object.assign(new Error("private ciphertext"),{code:"XX000"}),{message:"private secret"}]) {
      const response=apiError(error); expect(response.status).toBe(503);
      expect(await response.json()).toEqual({error:"Could not complete the request."});
      expect(publicGitHubMessage(error)).toBe("Could not complete the request.");
    }
    for(const [error,status] of [
      [new GitHubRequestError("Choose a frame."),400],[new GitHubRequestError("Origin denied.",403),403],
      [new OrganizationAccessError("Workspace access denied."),403],[new RequestBodyError("Too large.",413),413],
      [new GitHubHistoryLimitError(),409],[new GitHubWorkLimitError(),422],
      [new GitHubError(401),401],[new GitHubError(404),404],[new GitHubError(403),502],
    ]) { const response=apiError(error); expect(response.status).toBe(status); expect((await response.json()).error).toBe(error.message); expect(response.headers.get("cache-control")).toBe("private, no-store"); }
    const invalid=z.object({field:z.string()}).safeParse({field:123});
    expect((await apiError(invalid.error).json()).error).toBe("Invalid request fields.");
    const limited=apiError(new MutationBudgetError(23)); expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBe("23");
    const busy=apiError(new ImageCapacityError()); expect(busy.status).toBe(503); expect(busy.headers.get("retry-after")).toBe("1");
    expect(apiError(new ImageBudgetUnavailableError()).status).toBe(503);
    mock.module("./lib/github/reviews.ts",()=>({
      listReviews:async()=>{throw new Error("private tool token");},createFeedback:async()=>({}),getReviewContext:async()=>({}),
      linkPullRequest:async()=>({}),recordFeedbackResponse:async()=>({}),uploadCapture:async()=>({}),
    }));
    mock.module("./lib/github/images.ts",()=>({reviewImageBytes:async()=>({})}));
    const {registerGitHubTools}=await import("./lib/github/mcp.ts"); const handlers=new Map();
    registerGitHubTools({registerTool:(name,_schema,handler)=>handlers.set(name,handler)},"actor");
    const result=await handlers.get("list_pull_request_reviews")({file_id:"file"});
    expect(result.isError).toBe(true); expect(result.content[0].text).toBe("Could not complete the request.");
    console.log("PASS");
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString()).toContain("PASS");
});
