import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("server public responses report the original value before selecting UI copy and preserve redirects", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    mock.module("server-only", () => ({}));
    const captured = [];
    mock.module("@/lib/posthog-server", () => ({ createErrorReporter: () => async (error, details) => { captured.push({ error, details }); } }));
    const { actionError } = await import("./lib/action-error.ts");
    const { PublicActionError } = await import("./lib/security/public-error.ts");
    const original = Object.assign(new Error("private database details", { cause: new Error("connection reset") }), { code: "XX000" });
    const stack = original.stack;
    expect(actionError(original, "Could not create the file.")).toBe("Could not create the file.");
    expect(captured[0].error).toBe(original);
    expect(captured[0].details.operation).toBe("action.failed");
    expect(original.stack).toBe(stack);
    expect(original.cause.message).toBe("connection reset");
    expect(original.code).toBe("XX000");
    actionError(original, "Other fallback");
    expect(captured.length).toBe(1);
    expect(actionError(new PublicActionError("Enter a folder name."), "Fallback")).toBe("Enter a folder name.");
    expect(captured.length).toBe(1);
    // Expected request/validation results must not exhaust exception admission.
    mock.module("@/lib/auth", () => ({ auth: { api: {} } }));
    mock.module("@/lib/agents/store", () => ({ agentsSchemaReady: async () => true }));
    const { agentFailure } = await import("./lib/agents/http.ts");
    const { AgentError } = await import("./lib/agents/protocol.ts");
    const { apiError } = await import("./lib/github/http.ts");
    const { GitHubRequestError } = await import("./lib/github/request-error.ts");
    const { GitHubError } = await import("./lib/github/client.ts");
    const { privacyFailure, PrivacyError } = await import("./lib/privacy/access.ts");
    const { PersonalBudgetError } = await import("./lib/security/personal-budget.ts");
    const { imageFailureResponse } = await import("./lib/design/image-budget.ts");
    const { MutationBudgetError } = await import("./lib/security/mutation-budget.ts");
    const { z } = await import("zod");
    expect(agentFailure(new AgentError("invalid_input", "Check the input.")).status).toBe(400);
    expect(agentFailure(z.string().safeParse(12).error).status).toBe(400);
    expect(apiError(new GitHubRequestError("Expected JSON.", 415)).status).toBe(415);
    expect(apiError(new GitHubError(404)).status).toBe(404);
    expect(privacyFailure(new PrivacyError("Sign in.", 401)).status).toBe(401);
    expect(privacyFailure(new PersonalBudgetError(429)).status).toBe(429);
    expect(imageFailureResponse(new MutationBudgetError(60)).status).toBe(429);
    expect(captured.length).toBe(1);
    for (const boundary of [agentFailure, apiError, privacyFailure]) {
      const failure = new Error("private database failure", { cause: original });
      boundary(failure);
      expect(captured.at(-1).error).toBe(failure);
      expect(captured.at(-1).error.cause).toBe(original);
    }
    const upstream = new GitHubError(503);
    expect(apiError(upstream).status).toBe(502);
    expect(captured.at(-1).error).toBe(upstream);
    const budgetFailure = new PersonalBudgetError(503, { cause: original });
    privacyFailure(budgetFailure);
    expect(captured.at(-1).error).toBe(budgetFailure);
    const beforeNavigation = captured.length;
    const { redirect } = await import("next/navigation");
    let navigation;
    try { redirect("/files"); } catch (error) { navigation = error; }
    expect(() => actionError(navigation, "Fallback")).toThrow(navigation);
    expect(captured.length).toBe(beforeNavigation);
  `,
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
});
