import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function fixture(leak = false, leakRuntime = false, leakApi = false) {
  const root = await mkdtemp(path.join(tmpdir(), "tidy-monitoring-env-"));
  const credential = "phx_TEST_BUILD_ONLY_CREDENTIAL";
  const runtimeSecret = crypto.randomUUID();
  const apiKey = `mail-${crypto.randomUUID()}`;
  await mkdir(path.join(root, ".open-next/cloudflare"), { recursive: true });
  await mkdir(path.join(root, ".next"));
  await writeFile(
    path.join(root, ".open-next/cloudflare/next-env.mjs"),
    ["production", "development", "test"]
      .map(
        (mode) =>
          `export const ${mode} = ${JSON.stringify({ POSTHOG_API_KEY: credential, BETTER_AUTH_SECRET: runtimeSecret, RESEND_API_KEY: apiKey, DATABASE_URL: "postgres://fixture:fixture@localhost/fixture", KEEP_RUNTIME: "yes" })};`,
      )
      .join("\n"),
  );
  await writeFile(
    path.join(root, ".next/required-server-files.json"),
    JSON.stringify({ config: { env: { NEXT_PUBLIC_APP_VERSION: "release-test" } } }),
  );
  if (leak) await writeFile(path.join(root, ".open-next/leaked.js"), credential);
  if (leakRuntime) await writeFile(path.join(root, ".open-next/leaked-runtime.js"), runtimeSecret);
  if (leakApi) await writeFile(path.join(root, ".open-next/leaked-api.js"), apiKey);
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dirname, "finalize-worker-env.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        POSTHOG_API_KEY: credential,
        NEXT_PUBLIC_POSTHOG_KEY: "phc_TEST",
        NEXT_PUBLIC_POSTHOG_HOST: "https://posthog.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await child.exited;
  return { root, code, runtimeSecret, apiKey, stderr: await new Response(child.stderr).text() };
}

test("Worker build removes local runtime and management credentials and retains public configuration", async () => {
  const { root, code } = await fixture();
  try {
    expect(code).toBe(0);
    const compiled = await readFile(path.join(root, ".open-next/cloudflare/next-env.mjs"), "utf8");
    expect(compiled).not.toContain("POSTHOG_API_KEY");
    expect(compiled).not.toContain("phx_TEST");
    expect(compiled).toContain("phc_TEST");
    expect(compiled).toContain("release-test");
    expect(compiled).not.toContain("KEEP_RUNTIME");
    expect(compiled).not.toContain("BETTER_AUTH_SECRET");
    expect(compiled).not.toContain("DATABASE_URL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Worker build rejects local runtime credentials elsewhere in the artifact without disclosing them", async () => {
  const { root, code, stderr, runtimeSecret } = await fixture(false, true);
  try {
    expect(code).not.toBe(0);
    expect(stderr).toContain("Private credential found");
    expect(stderr).not.toContain(runtimeSecret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Worker build rejects artifacts that still contain the upload credential", async () => {
  const { root, code, stderr } = await fixture(true);
  try {
    expect(code).not.toBe(0);
    expect(stderr).toContain("Private credential found");
    expect(stderr).not.toContain("phx_TEST_BUILD_ONLY_CREDENTIAL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Worker build rejects private provider API keys elsewhere in the artifact", async () => {
  const { root, code, stderr, apiKey } = await fixture(false, false, true);
  try {
    expect(code).not.toBe(0);
    expect(stderr).toContain("Private credential found");
    expect(stderr).not.toContain(apiKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
