import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checksum, packSnapshot } from "./desktop-demo-snapshot.mjs";

const version = process.argv[2];
if (!version || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(version) || process.argv.length !== 3)
  throw new Error("Usage: bun run --cwd apps/site demo:update <version>");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const inputs = [
  "apps/desktop",
  "packages",
  "scripts/bundle-licenses.ts",
  "licenses",
  "LICENSE",
  "bun.lock",
  "package.json",
];
if (execFileSync("git", ["status", "--porcelain", "--", ...inputs], { cwd: root }).length)
  throw new Error("Commit desktop demo source changes before pinning a new version.");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
execFileSync("bun", ["run", "--cwd", "apps/desktop", "build:demo"], {
  cwd: root,
  stdio: "inherit",
});
const bytes = await packSnapshot(
  fileURLToPath(new URL("../../desktop/demo-dist/", import.meta.url)),
);
const destination = new URL("../desktop-demo/", import.meta.url);
await mkdir(destination, { recursive: true });
await writeFile(new URL("snapshot.json.gz", destination), bytes);
await writeFile(
  new URL("manifest.json", destination),
  JSON.stringify({ format: 1, version, sourceCommit, sha256: checksum(bytes) }, null, 2) + "\n",
);
console.log(
  `Pinned desktop demo ${version} from ${sourceCommit}. Review and commit desktop-demo/.`,
);
