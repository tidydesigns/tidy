import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Only loaded by the disposable MCP fixture, never by the deployed application.
// The bridge supplies a synthetic grant and forwards every call over real HTTP
// to the actual authenticated route. Browser access is restricted to local origins.
export async function serveMcpWorkflow({ POST, auth, admin, grant, fetch }) {
  await admin.query('update "billingDeployment" set "selfHosted"=true');
  const { token } = await auth.api.signJWT({
    body: { payload: grant({ exp: Math.floor(Date.now() / 1000) + 7200 }).claims },
  });
  const port = Number(process.env.MCP_WORKFLOW_PORT ?? 4319);
  const directory = process.env.MCP_WORKFLOW_OUTPUT ?? "/tmp/tidy-mcp-workflow";
  await mkdir(directory, { recursive: true });
  // Deterministic font-provider fixture uses this checkout's exact source fonts.
  // It exercises the real preview packager without public network dependencies.
  const previousFetch = globalThis.fetch;
  const fonts = new Map([
    [
      "Instrument Sans",
      new URL("../../../site/app/fonts/instrument-sans-latin.woff2", import.meta.url),
    ],
    [
      "Instrument Serif",
      new URL("../../../site/app/fonts/InstrumentSerif-Regular.woff2", import.meta.url),
    ],
  ]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "fonts.googleapis.com") {
      const [family, axes] = (url.searchParams.get("family") ?? "").split(":");
      if (fonts.has(family)) {
        const weight = axes?.split(",").at(-1) ?? "400";
        return new Response(
          `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; src: url(https://fonts.gstatic.com/tidy-fixture/${encodeURIComponent(family)}.woff2) format('woff2'); }`,
        );
      }
    }
    if (url.hostname === "fonts.gstatic.com" && url.pathname.startsWith("/tidy-fixture/")) {
      const family = decodeURIComponent(
        url.pathname.slice("/tidy-fixture/".length).replace(/\.woff2$/, ""),
      );
      const file = fonts.get(family);
      if (file)
        return new Response(await Bun.file(file).arrayBuffer(), {
          headers: { "Content-Type": "font/woff2" },
        });
    }
    return previousFetch(input, init);
  };
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    "http://localhost:3001",
    "http://127.0.0.1:3001",
  ]);
  const previews = new Map();
  const calls = [];
  let complete;
  const finished = new Promise((resolve) => {
    complete = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/mcp") return POST(request);
      const origin = request.headers.get("origin");
      if (origin && !allowed.has(origin))
        return new Response("Local fixture only", { status: 403 });
      const headers = {
        "Access-Control-Allow-Origin": origin ?? `http://127.0.0.1:${port}`,
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
      };
      if (request.method === "OPTIONS") return new Response(null, { headers });
      if (url.pathname === "/client.js")
        return new Response(
          await Bun.file(new URL("../../scripts/fixtures/mcp-workflow.js", import.meta.url)).text(),
          { headers: { ...headers, "Content-Type": "text/javascript" } },
        );
      if (url.pathname.startsWith("/preview/")) {
        const html = previews.get(url.pathname.slice(9));
        return new Response(html ?? "Preview not found", {
          status: html ? 200 : 404,
          headers: { ...headers, "Content-Type": "text/html" },
        });
      }
      if (url.pathname === "/finish" && request.method === "POST") {
        // Let the acknowledgement reach the browser before fixture teardown.
        setTimeout(complete, 100);
        return Response.json({ done: true }, { headers });
      }
      if (url.pathname !== "/call" || request.method !== "POST")
        return Response.json(
          { fixture: "Disposable local MCP workflow", calls: calls.length },
          { headers },
        );
      const { name, arguments: args = {} } = await request.json();
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const body = await response.text();
      const message = response.headers.get("content-type")?.includes("text/event-stream")
        ? body
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)))
            .find((entry) => entry.id === 1)
        : JSON.parse(body);
      const result = message?.result;
      const row = {
        name,
        elapsedMs: Math.round((performance.now() - start) * 100) / 100,
        status: response.status,
        bytes: Buffer.byteLength(body),
        isError: Boolean(message?.error || result?.isError),
      };
      calls.push(row);
      await writeFile(join(directory, "calls.json"), JSON.stringify(calls, null, 2));
      if (name === "import_web_capture")
        await writeFile(join(directory, "capture.json"), JSON.stringify(args.capture));
      if (name === "get_document" && result?.structuredContent?.document)
        await writeFile(
          join(directory, "document.json"),
          JSON.stringify(result.structuredContent.document),
        );
      if (result?.structuredContent?.html) {
        const id = String(previews.size + 1);
        previews.set(id, result.structuredContent.html);
        await writeFile(join(directory, `preview-${id}.html`), result.structuredContent.html);
        result.structuredContent.fixturePreviewUrl = `http://127.0.0.1:${port}/preview/${id}`;
      }
      return Response.json({ ...message, fixtureMeasurement: row }, { headers });
    },
  });
  console.info(
    `Local MCP workflow: http://127.0.0.1:${port}; synthetic data only; output ${directory}`,
  );
  try {
    await finished;
  } finally {
    globalThis.fetch = previousFetch;
    await server.stop();
  }
}
