import { expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { instrumentMcpServer, McpActivity } from "./activity";
import { activityPath, summarizeImportChunks } from "./activity-summary";
import type { AgentActivity } from "@/lib/realtime/agent-activity";

function setup(scope: { fileId: string } | null = { fileId: "file" }) {
  const events: AgentActivity[] = [];
  const services = {
    resolve: mock(async () => scope),
    name: mock(async () => "Codex"),
    publish: mock(async (event: AgentActivity) => {
      events.push(event);
    }),
  };
  const agent = new McpActivity({ userId: "human", clientId: "registered-client" }, services);
  return { agent, events, services };
}
test("authorized targets get truthful start/result phases without payloads or raw identities", async () => {
  const { agent, events } = setup();
  const output = { structuredContent: { revision: 42 }, content: [] };
  expect(
    await agent.run(
      "patch_document",
      { file_id: "file", node_id: "node", changes: { text: "private" } },
      async () => output,
    ),
  ).toBe(output);
  expect(events.map((event) => event.phase)).toEqual(["editing", "completed"]);
  expect(events[1].revision).toBe(42);
  expect(events[1].actorId).not.toContain("registered-client");
  expect(JSON.stringify(events)).not.toContain("private");
});
test("resolved MCP errors and validation failures are not successful activity", async () => {
  const { agent, events } = setup();
  await agent.run("patch_document", { file_id: "file" }, async () => ({ isError: true }));
  expect(events.at(-1)?.phase).toBe("failed");
  await agent.run("validate_import", { import_id: crypto.randomUUID() }, async () => ({
    structuredContent: { nodeCount: 12, layout: { valid: false, issues: [1, 2] } },
  }));
  expect(events.at(-1)).toMatchObject({ phase: "failed", nodeCount: 12, issueCount: 2 });
});
test("image reads publish reading activity without leaking original bytes", async () => {
  const { agent, events } = setup();
  await agent.run("get_file_image", { file_id: "file", asset_id: "asset" }, async () => ({
    content: [{ type: "image", data: "private-image-bytes", mimeType: "image/png" }],
    structuredContent: { revision: 7, base64: "private-image-bytes" },
  }));
  expect(events.map((event) => event.phase)).toEqual(["reading", "completed"]);
  expect(events.at(-1)?.revision).toBe(7);
  expect(JSON.stringify(events)).not.toContain("private-image-bytes");
});
test("activity publication failure preserves successful edits and original thrown failures", async () => {
  const { agent, services } = setup();
  services.publish.mockRejectedValue(new Error("Relay offline"));
  expect(await agent.run("patch_document", { file_id: "file" }, async () => 42)).toBe(42);
  const failure = new Error("Revision conflict");
  await expect(
    agent.run("patch_document", { file_id: "file" }, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});
test("unknown destinations and unscoped guidance never fabricate activity", async () => {
  const { agent, events, services } = setup(null);
  await agent.run("get_document", { file_id: "other" }, async () => ({ isError: true }));
  await agent.run("compose_component", {}, async () => ({ structuredContent: {} }));
  expect(events).toEqual([]);
  expect(services.resolve).toHaveBeenCalledTimes(1);
});
test("intermediate counters are coalesced while real phase changes and completion stay immediate", async () => {
  const { agent, events } = setup();
  await agent.run("import_web_capture", { file_id: "file" }, async (observe) => {
    for (let i = 0; i < 50; i++) await observe("receiving", { nodeCount: i });
    await observe("validating");
    await observe("publishing");
    return { structuredContent: { revision: 2, importedNodeCount: 50 } };
  });
  expect(events.map((event) => event.phase)).toEqual([
    "receiving",
    "validating",
    "publishing",
    "published",
  ]);
  expect(events[1].nodeCount).toBe(49);
  expect(events.at(-1)?.nodeCount).toBe(50);
});
test("SDK registration wrapper preserves callback arguments and no-input tool semantics", async () => {
  const { agent, events } = setup();
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      handler: (...args: unknown[]) => Promise<unknown>,
    ) {
      handlers.set(name, handler);
      return { name };
    },
  };
  const wrapped = instrumentMcpServer(server as unknown as McpServer, agent);
  const callback = mock(async (...args: unknown[]) => ({ args }));
  const register = wrapped.registerTool as unknown as typeof server.registerTool;
  register("get_document", {}, callback);
  register("get_design_guidance", {}, callback);
  const context = { signal: new AbortController().signal },
    input = { file_id: "file" };
  await handlers.get("get_document")!(input, context);
  expect(callback).toHaveBeenCalledWith(input, context);
  await handlers.get("get_design_guidance")!(context);
  expect(callback).toHaveBeenLastCalledWith(context);
  expect(events).toHaveLength(2);
});
test("accepted chunk summaries deduplicate paths/assets and reject private path forms", () => {
  const chunk = {
    nodes: [
      { id: "frame", parentId: null, sourcePath: "app/login.tsx", assetId: "asset" },
      {
        id: "child",
        parentId: "frame",
        sourcePath: "app/login.tsx",
        style: { paints: [{ assetId: "asset" }] },
      },
    ],
    source: { project: "acme", route: "/login?token=private" },
    warnings: [],
  };
  expect(summarizeImportChunks({ a: chunk })).toMatchObject({
    nodeCount: 2,
    assetCount: 1,
    sourcePaths: ["app/login.tsx"],
    sourceRoute: "/login",
    nodeIds: ["frame"],
  });
  for (const value of [
    "/Users/person/private.ts",
    "../private.ts",
    "C:\\Users\\private",
    "https://private.example/",
  ])
    expect(activityPath(value)).toBeUndefined();
});
