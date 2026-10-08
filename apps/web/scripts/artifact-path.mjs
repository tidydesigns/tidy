import { mkdirSync } from "node:fs";
import path from "node:path";
export function artifactPath(name) {
  if (path.basename(name) !== name) throw new Error("Provide an artifact filename.");
  const directory = path.resolve(import.meta.dirname, "../.artifacts/editor-verification");
  mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}
