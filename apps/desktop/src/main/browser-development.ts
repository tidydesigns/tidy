import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect } from "vite";
import { z } from "zod";
import { projectAssetResponse } from "./project-assets";
import { createWorkspaceRequests } from "./workspace-requests";
import type { WorkspaceService } from "./workspace-service";

const envelope = z
  .object({
    name: z.string().min(1).max(80),
    input: z.unknown().optional(),
    projectPath: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine(isAbsolute, "Enter an absolute Linux folder path.")
      .optional(),
    file: z
      .object({ name: z.string().min(1).max(200), document: z.unknown() })
      .strict()
      .optional(),
  })
  .strict();
const cookieName = "tidy_development";
const maxBody = 32 * 1024 * 1024;

function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new Error("Expected JSON.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBody) throw new Error("The request is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function browserDevelopment(
  service: WorkspaceService,
  projectPath: string,
  origin: URL,
  token: string,
) {
  // Keep browser access stable across restarts; rotating the private token revokes it.
  const session = createHmac("sha256", token)
    .update("tidy-development-session-v1\0")
    .update(origin.origin)
    .update("\0")
    .update(projectPath)
    .digest("base64url");
  const epoch = randomBytes(8).toString("hex");
  let sequence = 0,
    historyBytes = 0;
  const streams = new Set<ServerResponse>();
  const history: { id: string; data: string }[] = [];
  const requests = createWorkspaceRequests<z.infer<typeof envelope>>(service, {
    chooseProject: async (context) => {
      if (!context.projectPath) throw new Error("Choose a Linux project folder.");
      return context.projectPath;
    },
    chooseDesign: async ({ file }) => file ?? null,
    openExternal: async () => {
      throw new Error("Open provider usage in your browser.");
    },
    showItemInFolder: () => {
      throw new Error("File links can be revealed from the desktop app.");
    },
  });
  const unsubscribe = service.subscribeRenderer((event) => {
    const id = `${epoch}:${++sequence}`;
    const data = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
    history.push({ id, data });
    historyBytes += Buffer.byteLength(data);
    while (history.length > 128 || historyBytes > 2 * 1024 * 1024) {
      historyBytes -= Buffer.byteLength(history.shift()!.data);
    }
    for (const stream of streams) {
      if (stream.writableLength > 2 * 1024 * 1024) stream.end();
      else stream.write(data);
    }
  });
  function authenticated(request: IncomingMessage) {
    const cookie = request.headers.cookie
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${cookieName}=`));
    return equal(cookie?.slice(cookieName.length + 1) ?? "", session);
  }
  function trustedHost(request: IncomingMessage) {
    return [origin.host, "127.0.0.1:5173", "localhost:5173"].includes(request.headers.host ?? "");
  }
  function trustedOrigin(request: IncomingMessage) {
    return request.headers.origin === origin.origin;
  }
  function json(response: ServerResponse, status: number, data: unknown) {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(data));
  }
  const middleware: Connect.NextHandleFunction = async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (!trustedHost(request)) {
      json(response, 403, { ok: false, error: "Untrusted host." });
      return;
    }
    const path = request.url?.split("?")[0];
    try {
      if (path === "/__tidy/session" && request.method === "POST") {
        if (!trustedOrigin(request)) {
          json(response, 403, { ok: false, error: "Untrusted origin." });
          return;
        }
        const input = z
          .object({ token: z.string().max(200) })
          .strict()
          .parse(await readBody(request));
        if (!equal(input.token, token)) {
          json(response, 401, { ok: false, error: "Invalid development link." });
          return;
        }
        response.setHeader(
          "Set-Cookie",
          `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${origin.protocol === "https:" ? "; Secure" : ""}`,
        );
        json(response, 200, { ok: true });
        return;
      }
      if (!authenticated(request)) {
        if (path === "/" && request.method === "GET") {
          response.writeHead(200, {
            "Content-Type": "text/html",
            "Content-Security-Policy":
              "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
          });
          response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Tidy development</title><style>body{font:16px system-ui;margin:3rem;max-width:36rem}</style><p id="status">Connecting to Tidy…</p><script>
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
if (!token) document.getElementById('status').textContent = 'Open the private development link printed by bun dev:desktop:browser.';
else fetch('/__tidy/session', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r => {if (!r.ok) throw Error(); location.reload();}).catch(() => document.getElementById('status').textContent = 'This development link is invalid. Open the latest link from your development server.');
</script>`);
        } else json(response, 401, { ok: false, error: "Open your private development link." });
        return;
      }
      // Block cross-origin API requests, including requests with browser cookies.
      if (request.method !== "GET" && !trustedOrigin(request)) {
        json(response, 403, { ok: false, error: "Untrusted origin." });
        return;
      }
      if (path?.startsWith("/__tidy/assets/")) {
        const asset = await projectAssetResponse(
          service.store,
          new Request(new URL(request.url!, origin).href, {
            method: request.method,
            headers: request.headers["if-none-match"]
              ? { "If-None-Match": request.headers["if-none-match"] }
              : undefined,
          }),
        );
        response.writeHead(asset.status, Object.fromEntries(asset.headers));
        response.end(Buffer.from(await asset.arrayBuffer()));
        return;
      }
      if (path === "/__tidy/directories" && request.method === "GET") {
        const url = new URL(request.url!, origin);
        const selected = url.searchParams.get("path") ?? homedir();
        if (!isAbsolute(selected) || selected.length > 4096)
          throw new Error("Enter an absolute Linux folder path.");
        const directory = await realpath(selected);
        const entries = await readdir(directory, { withFileTypes: true });
        const directories = entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 1000)
          .map((entry) => ({ name: entry.name, path: join(directory, entry.name) }));
        json(response, 200, {
          ok: true,
          data: {
            path: directory,
            parent: dirname(directory) === directory ? null : dirname(directory),
            directories,
            initialProject: projectPath,
          },
        });
        return;
      }
      if (path === "/__tidy/request" && request.method === "POST") {
        const input = envelope.parse(await readBody(request));
        json(response, 200, {
          ok: true,
          data: await requests.invoke(input.name, input.input, input),
        });
        return;
      }
      if (path === "/__tidy/events" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write(": connected\n\n");
        const lastId = request.headers["last-event-id"];
        if (lastId) {
          const index = history.findIndex((event) => event.id === lastId);
          if (index >= 0) for (const event of history.slice(index + 1)) response.write(event.data);
          else if (lastId !== `${epoch}:${sequence}`) response.write("event: resync\ndata: {}\n\n");
        } else response.write("event: resync\ndata: {}\n\n");
        // Even quiet connections carry a cursor, allowing recovery across a server restart.
        response.write(`id: ${epoch}:${sequence}\n\n`);
        streams.add(response);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
        response.on("close", () => {
          clearInterval(heartbeat);
          streams.delete(response);
        });
        return;
      }
      if (path?.startsWith("/__tidy/")) {
        json(response, 404, { ok: false, error: "Unknown development endpoint." });
        return;
      }
      next();
    } catch (error) {
      json(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "The operation could not be completed.",
      });
    }
  };
  return {
    middleware,
    authorizeUpgrade(request: IncomingMessage) {
      return trustedHost(request) && trustedOrigin(request) && authenticated(request);
    },
    close() {
      unsubscribe();
      for (const stream of streams) stream.end();
    },
  };
}
