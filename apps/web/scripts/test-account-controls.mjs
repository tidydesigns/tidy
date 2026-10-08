import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Own the entire cluster so the destructive fixtures never share a real database.
const suites = {
  versions: [
    "tidy_versions_test",
    "VERSION_TEST_DATABASE_URL",
    "design/file-versions.integration.test.ts",
  ],
  mcp: ["tidy_mcp_test", "MCP_TEST_DATABASE_URL", "mcp/grants.integration.test.mjs"],
  personal: [
    "tidy_personal_test",
    "PERSONAL_TEST_DATABASE_URL",
    "security/personal.integration.test.mjs",
  ],
  files: [
    "tidy_files_test",
    "FILES_TEST_DATABASE_URL",
    "design/file-management.integration.test.ts",
  ],
  images: [
    "tidy_images_test",
    "IMAGES_TEST_DATABASE_URL",
    "design/private-images.integration.test.ts",
  ],
  clipboard: [
    "tidy_clipboard_test",
    "CLIPBOARD_TEST_DATABASE_URL",
    "design/clipboard-assets.integration.test.ts",
  ],
  accounts: [
    "tidy_organizations_test",
    "ORGANIZATIONS_TEST_DATABASE_URL",
    "organizations/integration.test.ts",
  ],
  plans: ["tidy_plan_limits_test", "PLANS_TEST_DATABASE_URL", "billing/plans.integration.test.ts"],
  agents: ["tidy_agents_test", "AGENTS_TEST_DATABASE_URL", "agents/store.integration.test.ts"],
  auth: ["tidy_auth_test", "AUTH_TEST_DATABASE_URL", "auth-flows.integration.test.ts"],
  github: ["tidy_github_test", "GITHUB_TEST_DATABASE_URL", "github/integration.test.mjs"],
  runtime: [
    "tidy_runtime_test",
    "RUNTIME_TEST_DATABASE_URL",
    "security/runtime.integration.test.ts",
  ],
  storage: [
    "tidy_storage_test",
    "MULTIPLAYER_TEST_DATABASE_URL",
    "storage/object-collection.integration.test.ts",
  ],
  multiplayer: [
    "tidy_multiplayer_test",
    "MULTIPLAYER_TEST_DATABASE_URL",
    "realtime/commands.integration.test.mjs",
  ],
  linear: ["tidy_connectors_test", "LINEAR_TEST_DATABASE_URL", "linear/integration.test.mjs"],
};
const args = process.argv.slice(2);
const suite = args.length ? args[0].replace(/^--/, "") : "accounts";
if (args.length > 1 || !Object.hasOwn(suites, suite))
  throw new Error(
    "Choose --accounts, --auth, --plans, --agents, --github, --linear, --runtime, --storage, --multiplayer, --clipboard, --images, --files, --versions, --personal or --mcp.",
  );
const [databaseName, databaseVariable, testFile] = suites[suite];
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "bella-account-tests-"));
const data = join(directory, "data");
const log = join(directory, "postgres.log");
let started = false;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error)
    throw new Error(
      `Could not run ${command}. Install PostgreSQL and Bun and make them available on PATH.`,
    );
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
}

try {
  // MCP routes import the generated widget; standalone fixture runs need it too.
  run("bun", ["run", "--cwd", "apps/gpt-plugin", "build"]);
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a local test port.");
  const port = address.port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  run("initdb", ["-D", data, "--auth=trust", "--username=bella_test", "--no-instructions"], {
    stdio: "ignore",
  });
  try {
    run("pg_ctl", [
      "-D",
      data,
      "-l",
      log,
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${directory}`,
      "-w",
      "start",
    ]);
  } catch (error) {
    if (existsSync(log)) console.error(readFileSync(log, "utf8"));
    throw error;
  }
  started = true;
  run("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "bella_test", databaseName]);
  const url = `postgres://bella_test@127.0.0.1:${port}/${databaseName}`;
  if (
    [
      "multiplayer",
      "storage",
      "runtime",
      "clipboard",
      "images",
      "files",
      "linear",
      "agents",
      "personal",
      "github",
      "mcp",
      "versions",
    ].includes(suite)
  ) {
    run("sh", ["apps/web/scripts/init-local-postgres.sh"], {
      env: {
        ...process.env,
        MIGRATIONS_DIR: join(root, "migrations"),
        POSTGRES_USER: "bella_test",
        POSTGRES_DB: databaseName,
        PGHOST: "127.0.0.1",
        PGPORT: String(port),
      },
    });
  }
  let applicationUrl = url;
  if (
    [
      "runtime",
      "clipboard",
      "images",
      "files",
      "linear",
      "agents",
      "personal",
      "github",
      "mcp",
      "versions",
    ].includes(suite)
  ) {
    const grants = readFileSync(join(root, "migrations/operations/runtime-grants.sql"), "utf8");
    run("psql", ["--dbname", url, "--set", "ON_ERROR_STOP=1"], {
      stdio: ["pipe", "inherit", "inherit"],
      input: `begin; create role tidy_runtime_fixture login nosuperuser nobypassrls nocreatedb nocreaterole;
        grant pg_read_all_data, pg_write_all_data to tidy_runtime_fixture;
        select set_config('tidy.runtime_role','tidy_runtime_fixture',true); ${grants} commit;`,
    });
    const restricted = new URL(url);
    restricted.username = "tidy_runtime_fixture";
    applicationUrl = restricted.toString();
  }
  run("bun", ["test", `apps/web/lib/${testFile}`], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: applicationUrl,
      [databaseVariable]: applicationUrl,
      ...(suite === "clipboard" ? { CLIPBOARD_SETUP_DATABASE_URL: url } : {}),
      ...(suite === "images" ? { IMAGES_SETUP_DATABASE_URL: url } : {}),
      ...(suite === "files" ? { FILES_SETUP_DATABASE_URL: url } : {}),
      ...(suite === "linear" ? { LINEAR_SETUP_DATABASE_URL: url } : {}),
      ...(suite === "agents" ? { AGENTS_SETUP_DATABASE_URL: url } : {}),
      ...(suite === "personal" ? { PERSONAL_SETUP_DATABASE_URL: url } : {}),
      ...(suite === "github" ? { GITHUB_SETUP_DATABASE_URL: url } : {}),
      ...(suite === "mcp" ? { MCP_SETUP_DATABASE_URL: url } : {}),
      ...(suite === "versions" ? { VERSION_SETUP_DATABASE_URL: url } : {}),
      AGENT_RUNNER_URL: "",
      AGENT_RUNNER_SECRET: "",
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "disposable-account-test-secret-at-least-32-characters",
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Account tests failed.");
  process.exitCode = 1;
} finally {
  if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  rmSync(directory, { recursive: true, force: true });
}
