import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { checkPublicSource } from "./public-source.mjs";

// Export one reviewed commit, never the working directory or its Git history.
export function exportSource(repository, destination) {
  const root = path.resolve(repository);
  const output = path.resolve(destination);
  if (output === root || output.startsWith(`${root}${path.sep}`))
    throw new Error("Export to a new directory outside the source checkout.");
  if (existsSync(output)) throw new Error("The export destination must not exist.");
  const files = execFileSync("git", ["ls-tree", "-r", "-z", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  for (const entry of files) {
    const [metadata, name] = entry.split("\t");
    if (!metadata.startsWith("100644 ") && !metadata.startsWith("100755 "))
      throw new Error(`Symlinks and submodules require manual review: ${name}`);
  }
  const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  mkdirSync(output, { recursive: true });
  try {
    execFileSync("tar", ["-xf", "-", "-C", output], { input: archive });
    checkPublicSource(output);
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return output;
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 3) throw new Error("Usage: bun run export:source /new/directory");
  console.info(
    `Source exported without Git history: ${exportSource(process.cwd(), process.argv[2])}`,
  );
}
