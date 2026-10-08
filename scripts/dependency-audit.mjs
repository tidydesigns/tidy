import { spawnSync } from "node:child_process";

const result = spawnSync("bun", ["audit", "--json"], { encoding: "utf8" });
if (result.error) throw result.error;
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  throw new Error("Dependency audit failed to return a registry report.");
}
let failed = false;
for (const [name, advisories] of Object.entries(report)) {
  for (const advisory of advisories) {
    // Reviewed ESLint-only exposure; all other packages/advisories fail closed.
    // The reviewed dependency path and mitigation are documented in SECURITY.md.
    let toolingOnly = name === "braces" && advisory.url.endsWith("GHSA-vfj7-8cjw-p6xm");
    if (toolingOnly) {
      const why = spawnSync("bun", ["pm", "why", "braces"], { encoding: "utf8" });
      const consumers = [...why.stdout.matchAll(/((?:@[\w-]+\/)?[\w.-]+)@(?:\d|workspace)/g)].map(
        (match) => match[1],
      );
      const allowed = new Set([
        "braces",
        "micromatch",
        "fast-glob",
        "@next/eslint-plugin-next",
        "eslint-config-next",
        "@bella/web",
        "@tidy/site",
      ]);
      toolingOnly =
        why.status === 0 &&
        consumers.length > 0 &&
        consumers.every((consumer) => allowed.has(consumer)) &&
        why.stdout.includes("dev @bella/web@workspace") &&
        why.stdout.includes("dev @tidy/site@workspace");
    }
    console.info(
      `${toolingOnly ? "DOCUMENTED TOOLING ADVISORY" : "BLOCKING ADVISORY"}: ${name}: ${advisory.title} (${advisory.url})`,
    );
    if (!toolingOnly) failed = true;
  }
}
if (result.status !== 0 && Object.keys(report).length === 0)
  throw new Error("Dependency audit returned no advisory details; retry before release.");
process.exitCode = failed ? 1 : 0;
