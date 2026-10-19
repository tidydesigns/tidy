import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { createServer } from "vite";
import { rendererConfig } from "../electron.vite.config";
import { ProjectStore } from "../src/main/project-store";
import { WorkspaceService } from "../src/main/workspace-service";
import { browserDevelopment } from "../src/main/browser-development";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    origin: { type: "string" },
    "token-file": { type: "string" },
  },
  strict: true,
});
const project = await realpath(resolve(values.project ?? process.cwd()));
const origin = new URL(values.origin ?? "http://127.0.0.1:5173");
if (
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  origin.username ||
  origin.password ||
  !["http:", "https:"].includes(origin.protocol)
)
  throw new Error("--origin must be an HTTP(S) origin, without a path or credentials.");
const key = createHash("sha256").update(project).digest("hex").slice(0, 20);
const state = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
  "tidy-browser",
  key,
);
await mkdir(state, { recursive: true, mode: 0o700 });
const tokenFile = resolve(values["token-file"] ?? join(state, "token"));
try {
  await writeFile(tokenFile, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const token = (await readFile(tokenFile, "utf8")).trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(token))
  throw new Error("The token file must contain a 32-byte base64url token.");
const store = new ProjectStore(state);
await store.initialize();
await store.recover();
const service = new WorkspaceService(store);
// Keep the last project chosen in the browser; --project supplies the first project.
const snapshot = store.activeProjectId
  ? await store.select(store.activeProjectId).catch(() => store.open(project))
  : await store.open(project);
await service.observe(snapshot.project.id);
const gateway = browserDevelopment(service, project, origin, token);
const server = await createServer({
  ...rendererConfig,
  configFile: false,
  root: resolve(import.meta.dirname, "../src/renderer"),
  plugins: [
    {
      name: "tidy-browser-development",
      configureServer(server) {
        server.middlewares.use(gateway.middleware);
        server.httpServer?.prependListener("upgrade", (request, socket) => {
          if (!gateway.authorizeUpgrade(request)) {
            console.warn("Rejected development websocket", {
              host: request.headers.host,
              origin: request.headers.origin,
              hasCookie: Boolean(request.headers.cookie),
            });
            socket.destroy();
          }
        });
      },
    },
    ...rendererConfig.plugins,
  ],
  server: {
    ...rendererConfig.server,
    allowedHosts: [origin.hostname],
    hmr:
      origin.protocol === "https:"
        ? { protocol: "wss", host: origin.hostname, clientPort: Number(origin.port || 443) }
        : undefined,
  },
});
await server.listen();
console.log(`Tidy browser development: ${origin.origin}/#token=${token}`);
console.log(
  `Project: ${project}\nRenderer changes reload automatically. Restart this command after backend changes.`,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  gateway.close();
  await service.close();
  await server.close();
  process.exit(0);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
