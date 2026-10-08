import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const generated = new Set([
  ".git",
  "node_modules",
  ".next",
  ".open-next",
  ".wrangler",
  ".turbo",
  ".wxt",
  ".output",
  ".artifacts",
  ".worktrees",
  "coverage",
]);

export function checkPublicSource(root) {
  let files = 0;
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file);
      if (
        generated.has(name) ||
        (name.startsWith(".env") && name !== ".env.example") ||
        name.startsWith(".dev.vars") ||
        name === "wrangler.deploy.jsonc" ||
        /\.(?:pem|key|p12|pfx|jks|sqlite3?|dump|har|log)$/.test(name)
      )
        throw new Error(`Private or generated file in export: ${relative}`);
      const info = lstatSync(file);
      if (info.isSymbolicLink()) throw new Error(`Symlink in export: ${relative}`);
      if (info.isDirectory()) walk(file);
      else {
        files++;
        const bytes = readFileSync(file);
        if (
          bytes.includes(Buffer.from(["-----BEGIN", "PRIVATE KEY-----"].join(" "))) ||
          bytes.includes(Buffer.from(["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ")))
        )
          throw new Error(`Private key in export: ${relative}`);
      }
    }
  }
  walk(root);
  return files;
}

if (process.argv[1] === import.meta.filename)
  console.info(
    `Checked ${checkPublicSource(path.resolve(process.argv[2] ?? "."))} exported files.`,
  );
