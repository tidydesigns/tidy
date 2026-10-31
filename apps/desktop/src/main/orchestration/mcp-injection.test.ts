import { expect, test } from "bun:test";
import { harnessArguments } from "../harnesses/interactive-harness";
import { acpInitializationSchema } from "../harnesses/opencode-adapter";

const mcp = {
  url: "http://127.0.0.1:1234/mcp",
  token: "private-token",
  toolNames: ["task_delegate", "canvas_edit", "canvas_read"],
  close() {},
};

test("Codex and Claude launch configuration references session credentials without exposing them in argv", () => {
  for (const harness of ["codex", "claude"] as const) {
    const args = harnessArguments({
      harness,
      executable: harness,
      cwd: "/tmp",
      mcp,
    });
    expect(args.join(" ")).toContain(mcp.url);
    expect(args.join(" ")).toContain("TIDY_AGENT_MCP_TOKEN");
    expect(args.join(" ")).not.toContain(mcp.token);
  }
});

test("ACP preserves declared HTTP capability during initialization validation", () => {
  expect(
    acpInitializationSchema.parse({
      agentCapabilities: { mcpCapabilities: { http: true } },
    }).agentCapabilities.mcpCapabilities?.http,
  ).toBe(true);
});

test("failed or cancelled MCP setup releases standalone process ownership", async () => {
  const { startInteractiveHarness } = await import("../harnesses/interactive-harness");
  let released = 0;
  const failed = startInteractiveHarness({
    harness: "codex",
    executable: "unused",
    cwd: "/tmp",
    prompt: "unused",
    onUpdate() {},
    onExit() {
      released++;
    },
    agentTools: {
      identity: "failed",
      async open() {
        throw new Error("Unavailable");
      },
    },
  });
  const error = await failed.done.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(released).toBe(1);
  const ready = Promise.withResolvers<{ url: string; token: string; close(): void }>();
  let closed = 0;
  const cancelled = startInteractiveHarness({
    harness: "codex",
    executable: "unused",
    cwd: "/tmp",
    prompt: "unused",
    onUpdate() {},
    onExit() {
      released++;
    },
    agentTools: { identity: "cancelled", open: () => ready.promise },
  });
  cancelled.stop();
  ready.resolve({
    url: "http://127.0.0.1/mcp",
    token: "secret",
    close() {
      closed++;
    },
  });
  await cancelled.done;
  expect(released).toBe(2);
  expect(closed).toBe(1);
});

test("native tool trust is limited to the injected server and preserves ask-before-edit mode", () => {
  const base = { executable: "fixture", cwd: "/tmp", mcp };
  const codex = harnessArguments({ ...base, harness: "codex" });
  expect(codex).toContain('mcp_servers.tidy.default_tools_approval_mode="approve"');
  expect(
    harnessArguments({ executable: "fixture", cwd: "/tmp", harness: "codex" }).join(" "),
  ).not.toContain("approval_mode");
  for (const permissionMode of ["default", "accept-edits", "plan"] as const) {
    const args = harnessArguments({ ...base, harness: "claude", settings: { permissionMode } });
    const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
    expect(allowed).toContain("mcp__tidy__task_delegate");
    expect(allowed).toContain("mcp__tidy__canvas_read");
    expect(allowed.includes("mcp__tidy__canvas_edit")).toBe(permissionMode !== "default");
    expect(allowed.every((name) => name.startsWith("mcp__tidy__"))).toBe(true);
    expect(allowed).not.toContain("*");
  }
});
