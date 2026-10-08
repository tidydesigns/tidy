import { resolve } from "node:path";
import { mkdir, rm, cp } from "node:fs/promises";
import { buildPlugin } from "./build";

await buildPlugin();
const root = resolve(import.meta.dir, "..");
const staging = resolve(root, "dist/package");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const path of ["plugin.json", "mcp.json", "skills", "assets"])
  await cp(resolve(root, path), resolve(staging, path), { recursive: true });
const target = resolve(root, "dist/tidy-plugin.zip");
await rm(target, { force: true });
const zip = Bun.spawn(["zip", "-qr", target, "."], {
  cwd: staging,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await zip.exited) !== 0) throw new Error("Could not package the plugin.");
console.log(target);
