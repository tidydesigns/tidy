import { expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
mock.module("server-only", () => ({}));
const { McpActivity } = await import("../mcp/activity");
const { registerTidyTools } = await import("../mcp/registry");
const { agentTools } = await import("./tools");

test("organisation scope exposes canvas tools while excluding connector and plugin tools", async () => {
  const names: string[] = [];
  const collector = {
    registerTool(name: string) {
      names.push(name);
    },
    registerResource() {},
  };
  registerTidyTools(
    collector as unknown as McpServer,
    "user",
    new McpActivity({ userId: "user", clientId: "test" }),
  );
  const full = agentTools("user", "worker", "Lead", undefined, undefined, true);
  const excluded = names.filter((name) => name.startsWith("linear_") || name === "preview_design");
  expect(excluded).toContain("linear_create_issue");
  expect(excluded).toContain("preview_design");
  expect(new Set(full.tools.map((tool) => tool.name))).toEqual(
    new Set(names.filter((name) => !excluded.includes(name))),
  );
  for (const name of excluded)
    await expect(full.invoke(name, {})).rejects.toMatchObject({ code: "tool_denied" });
  const limited = agentTools("user", "worker", "Lead");
  expect(limited.tools.some((tool) => tool.name === "patch_document")).toBe(true);
  expect(limited.tools.some((tool) => tool.name === "create_file")).toBe(false);
  expect(limited.tools.some((tool) => tool.name === "delete_folder")).toBe(false);
});
