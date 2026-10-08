const readTools = new Set([
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
]);
const readMethods = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
]);

export function requiredMcpScopes(message: unknown): readonly string[] {
  if (!message || typeof message !== "object" || Array.isArray(message))
    throw new Error("Send one JSON-RPC message.");
  const envelope = message as { method?: unknown; params?: { name?: unknown } };
  if (
    envelope.method === "tools/call" &&
    typeof envelope.params?.name === "string" &&
    envelope.params.name.startsWith("linear_")
  ) {
    const read = new Set([
      "linear_list_connections",
      "linear_list_teams",
      "linear_search_issues",
      "linear_get_issue",
      "linear_list_comments",
    ]).has(envelope.params.name);
    return read ? ["mcp:read", "linear:read"] : ["mcp:read", "linear:read", "linear:write"];
  }
  if (envelope.method !== "tools/call")
    return typeof envelope.method === "string" && readMethods.has(envelope.method)
      ? ["mcp:read"]
      : ["mcp:read", "mcp:write"];
  return typeof envelope.params?.name === "string" && readTools.has(envelope.params.name)
    ? ["mcp:read"]
    : ["mcp:read", "mcp:write"];
}

export async function readMcpRequest(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("A JSON-RPC request body is required.");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  const { waitForSignal } = await import("@/lib/auth/request-lifecycle");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await waitForSignal(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error("The MCP request is too large.");
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const scopes = requiredMcpScopes(JSON.parse(new TextDecoder().decode(body)));
    // Next.js passes a Proxy around the request. workerd cannot unwrap it as
    // a native Request and instead tries to parse "[object Request]" as a URL.
    // Rebuild from explicit fields after inspecting the bounded body.
    return {
      request: new Request(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        redirect: request.redirect,
        body,
      }),
      scopes,
    };
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
