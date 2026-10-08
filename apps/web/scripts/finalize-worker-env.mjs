import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// OpenNext copies local .env files into its Worker. Runtime credentials belong
// in Cloudflare bindings; keep only deliberate public/build configuration here.
const envPath = path.resolve(".open-next/cloudflare/next-env.mjs");
const generated = await import(pathToFileURL(envPath).href);
const { config } = JSON.parse(await readFile(".next/required-server-files.json", "utf8"));
const credentials = new Set([process.env.POSTHOG_API_KEY].filter(Boolean));
const lines = ["production", "development", "test"].map((mode) => {
  const runtime = {};
  for (const [name, value] of Object.entries(generated[mode])) {
    if (name.startsWith("NEXT_PUBLIC_") || name === "POSTHOG_TRACING_ENABLED")
      runtime[name] = value;
    else if (
      value &&
      /SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ENCRYPTION_KEY|DATABASE_URL|API_KEY|CONNECTION_STRING/.test(
        name,
      )
    )
      credentials.add(value);
  }
  if (mode === "production") {
    for (const name of [
      "NEXT_PUBLIC_POSTHOG_KEY",
      "NEXT_PUBLIC_POSTHOG_HOST",
      "NEXT_PUBLIC_POSTHOG_SURVEY_ID",
      "POSTHOG_TRACING_ENABLED",
    ]) {
      if (process.env[name]) runtime[name] = process.env[name];
    }
    runtime.NEXT_PUBLIC_APP_VERSION = config.env.NEXT_PUBLIC_APP_VERSION;
  }
  return `export const ${mode} = ${JSON.stringify(runtime)};`;
});
await writeFile(envPath, `${lines.join("\n")}\n`);

async function verify(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await verify(file);
    else if (entry.isFile() && credentials.size) {
      const bytes = await readFile(file);
      if ([...credentials].some((key) => bytes.includes(key))) {
        throw new Error(`Private credential found in deployment artifact: ${file}`);
      }
    }
  }
}
await verify(".open-next");
console.info("Worker environment finalized; private environment values excluded.");
