import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runs = Number(process.env.BENCH_RUNS ?? 5);
if (!Number.isInteger(runs) || runs < 1) throw new Error("BENCH_RUNS must be a positive integer");
const output = resolve(root, process.env.BENCH_OUTPUT ?? ".artifacts/typecheck-benchmark");
mkdirSync(output, { recursive: true });

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const projects = ["apps", "packages"].flatMap((group) =>
  readdirSync(join(root, group)).flatMap((name) => {
    const workspace = `${group}/${name}`;
    let pkg;
    try {
      pkg = readJson(join(root, workspace, "package.json"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    // Reuse the fallback's compiler arguments, including both desktop projects.
    return [...(pkg.scripts?.["typecheck:tsc"] ?? "").matchAll(/(?:^|&&\s*)tsc\s+([^&]+)/g)].map(
      (match) => ({ workspace, args: match[1].trim().split(/\s+/) }),
    );
  }),
);
if (!projects.length) throw new Error("No typecheck:tsc workspace scripts found");

function execute(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const compilers = ["tsc", "tsrs"];
const result = {
  date: new Date().toISOString(),
  source: execute("git", ["rev-parse", "HEAD"]),
  dirty: Boolean(execute("git", ["status", "--porcelain", "--untracked-files=no"])),
  machine: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0].model,
    cores: cpus().length,
    memoryBytes: totalmem(),
  },
  node: process.version,
  bun: execute("bun", ["--version"]),
  versions: {
    tsc: Object.fromEntries(
      projects.map(({ workspace }) => [
        workspace,
        readJson(join(root, workspace, "node_modules/typescript/package.json")).version,
      ]),
    ),
    tsrs: readJson(join(root, "node_modules/tsrs/package.json")).version,
  },
  runs,
  samples: [],
};

function measure(label, compiler, iteration, command, args, cwd = root, memory = false) {
  const log = join(output, `${label.replaceAll("/", "-")}-${compiler}-${iteration}`);
  // macOS time reports bytes; Linux time reports KiB. Pipeline memory is omitted:
  // a process's maximum RSS doesn't measure the total of concurrent Turbo tasks.
  const timed = memory && ["darwin", "linux"].includes(platform());
  const timeArgs =
    platform() === "darwin" ? ["-l", "-o", `${log}.time`] : ["-f", "%M", "-o", `${log}.time`];
  const start = performance.now();
  const proc = spawnSync(
    timed ? "/usr/bin/time" : command,
    timed ? [...timeArgs, command, ...args] : args,
    { cwd, encoding: "utf8" },
  );
  const seconds = (performance.now() - start) / 1000;
  writeFileSync(`${log}.log`, `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`);
  if (proc.error) throw proc.error;
  if (proc.status !== 0) throw new Error(`${label} (${compiler}) failed; see ${log}.log`);
  let maxRssBytes = null;
  if (timed) {
    const timing = readFileSync(`${log}.time`, "utf8");
    maxRssBytes =
      platform() === "darwin"
        ? Number(timing.match(/(\d+)\s+maximum resident set size/)[1])
        : Number(timing.trim()) * 1024;
  }
  const sample = { label, compiler, iteration, seconds, maxRssBytes, exitCode: proc.status };
  result.samples.push(sample);
  writeFileSync(join(output, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `${label} ${compiler} ${iteration}: ${seconds.toFixed(3)}s${maxRssBytes === null ? "" : `, ${(maxRssBytes / 1024 ** 2).toFixed(1)} MiB`}`,
  );
}

const pipelineArgs = (compiler) => [
  compiler === "tsrs" ? "typecheck" : "typecheck:tsc",
  "--cache=local:,remote:",
];
console.log("Preparing generated route, extension and plugin types (not timed)...");
execute("bun", pipelineArgs("tsc"));
execute("bun", pipelineArgs("tsrs"));

for (const { workspace, args } of projects) {
  const cwd = join(root, workspace);
  const configIndex = args.indexOf("-p");
  const label = `${workspace}/${configIndex < 0 ? "tsconfig.json" : args[configIndex + 1]}`;
  const binaries = {
    tsc: join(cwd, "node_modules/.bin/tsc"),
    tsrs: join(root, "node_modules/.bin/tsrs"),
  };
  const flags = [...args, "--incremental", "false", "--pretty", "false"];
  for (const compiler of compilers) execute(binaries[compiler], flags, cwd);
  for (let i = 1; i <= runs; i++) {
    for (const compiler of i % 2 ? compilers : [...compilers].reverse()) {
      measure(label, compiler, i, binaries[compiler], flags, cwd, true);
    }
  }
}

// Current workspace configs use the default build-info location at their root.
// Keep separate snapshots so alternating TypeScript versions can reuse warm caches.
const workspaces = [...new Set(projects.map(({ workspace }) => workspace))];
function buildInfos() {
  return workspaces.flatMap((workspace) =>
    readdirSync(join(root, workspace))
      .filter((name) => name.endsWith(".tsbuildinfo"))
      .map((name) => join(root, workspace, name)),
  );
}
const originalBuildInfos = new Map(buildInfos().map((path) => [path, readFileSync(path)]));
const clearBuildInfos = () => buildInfos().forEach((path) => rmSync(path));
const restoreBuildInfos = (snapshot) => {
  clearBuildInfos();
  for (const [path, contents] of snapshot) writeFileSync(path, contents);
};
try {
  for (const mode of ["cold", "warm"]) {
    const snapshots = new Map();
    if (mode === "warm") {
      for (const compiler of compilers) {
        clearBuildInfos();
        execute("bun", pipelineArgs(compiler));
        snapshots.set(compiler, new Map(buildInfos().map((path) => [path, readFileSync(path)])));
      }
    }
    for (let i = 1; i <= runs; i++) {
      for (const compiler of i % 2 ? compilers : [...compilers].reverse()) {
        restoreBuildInfos(snapshots.get(compiler) ?? new Map());
        measure(`pipeline-${mode}`, compiler, i, "bun", pipelineArgs(compiler));
        if (mode === "warm")
          snapshots.set(compiler, new Map(buildInfos().map((path) => [path, readFileSync(path)])));
      }
    }
  }
} finally {
  restoreBuildInfos(originalBuildInfos);
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
console.table(
  [...new Set(result.samples.map(({ label }) => label))].map((label) => {
    const seconds = Object.fromEntries(
      compilers.map((compiler) => [
        compiler,
        median(
          result.samples
            .filter((sample) => sample.label === label && sample.compiler === compiler)
            .map((sample) => sample.seconds),
        ),
      ]),
    );
    return {
      project: label,
      "tsc (s)": seconds.tsc.toFixed(3),
      "tsrs (s)": seconds.tsrs.toFixed(3),
      speedup: `${(seconds.tsc / seconds.tsrs).toFixed(1)}x`,
    };
  }),
);
console.log(`Results and command logs: ${output}`);
