import { expect, test } from "bun:test";
import { readMcpRequest, requiredMcpScopes } from "./scopes";

test("Linear tools need explicit connector consent, separate from design read/write", () => {
  for (const name of [
    "linear_list_connections",
    "linear_list_teams",
    "linear_search_issues",
    "linear_get_issue",
    "linear_list_comments",
  ]) {
    expect(requiredMcpScopes({ method: "tools/call", params: { name } })).toEqual([
      "mcp:read",
      "linear:read",
    ]);
  }
  for (const name of [
    "linear_create_issue",
    "linear_add_comment",
    "linear_update_issue",
    "linear_future_tool",
  ]) {
    expect(requiredMcpScopes({ method: "tools/call", params: { name } })).toEqual([
      "mcp:read",
      "linear:read",
      "linear:write",
    ]);
  }
});

test("read requests use read scope; unknown tools and methods require write scope", () => {
  for (const name of [
    "list_organizations",
    "list_files",
    "get_file",
    "get_document",
    "get_file_image",
    "list_pull_request_reviews",
    "get_review_context",
    "list_review_feedback",
    "get_review_image",
    "list_folders",
    "get_import_guidance",
    "get_browser_capture_script",
    "get_design_guidance",
    "compose_component",
    "instantiate_component",
    "validate_document",
    "export_component",
    "export_visual_preview",
  ])
    expect(requiredMcpScopes({ method: "tools/call", params: { name } })).toEqual(["mcp:read"]);
  for (const name of ["create_file", "patch_document", "commit_import", "future_tool"])
    expect(requiredMcpScopes({ method: "tools/call", params: { name } })).toEqual([
      "mcp:read",
      "mcp:write",
    ]);
  expect(requiredMcpScopes({ method: "resources/read" })).toEqual(["mcp:read"]);
  expect(requiredMcpScopes({ method: "future/mutation" })).toEqual(["mcp:read", "mcp:write"]);
  expect(() => requiredMcpScopes([{ method: "tools/call" }])).toThrow("one JSON-RPC");
});

test("scope inspection preserves the body for the SDK and rejects oversized requests", async () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_document", arguments: { file_id: "one" } },
  });
  const controller = new AbortController();
  const parsed = await readMcpRequest(
    new Request("https://app.example/api/mcp", {
      method: "POST",
      body,
      signal: controller.signal,
      redirect: "manual",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
    }),
  );
  expect(parsed.request.url).toBe("https://app.example/api/mcp");
  expect(parsed.request.method).toBe("POST");
  expect(parsed.request.redirect).toBe("manual");
  expect(parsed.request.headers.get("Authorization")).toBe("Bearer test-token");
  expect(parsed.request.headers.get("Content-Type")).toBe("application/json");
  expect(parsed.request.headers.get("Accept")).toBe("application/json, text/event-stream");
  expect(parsed.request.headers.get("MCP-Protocol-Version")).toBe("2025-06-18");
  expect(await parsed.request.text()).toBe(body);
  expect(parsed.scopes).toEqual(["mcp:read"]);
  controller.abort();
  expect(parsed.request.signal.aborted).toBe(true);
  await expect(
    readMcpRequest(
      new Request("https://app.example/api/mcp", {
        method: "POST",
        body: "x".repeat(4 * 1024 * 1024 + 1),
      }),
    ),
  ).rejects.toThrow("too large");
});
