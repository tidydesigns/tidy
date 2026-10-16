import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertNoCredentials,
  uploadWorkerSourceMaps,
  uploadWorkerSourceMapsEnabled,
  validateWorkerSourceMap,
} from "./worker-source-maps.mjs";

test("explicit map uploads work when collection is enabled only in a preserved Worker binding", () => {
  expect(uploadWorkerSourceMapsEnabled({})).toBe(false);
  expect(uploadWorkerSourceMapsEnabled({ POSTHOG_UPLOAD_SOURCEMAPS: "1" })).toBe(true);
  expect(uploadWorkerSourceMapsEnabled({ POSTHOG_SERVER_ERRORS_ENABLED: "1" })).toBe(false);
  expect(
    uploadWorkerSourceMapsEnabled({
      POSTHOG_UPLOAD_SOURCEMAPS: "0",
      POSTHOG_SERVER_ERRORS_ENABLED: "1",
      NEXT_PUBLIC_POSTHOG_ENABLED: "1",
    }),
  ).toBe(false);
  expect(
    uploadWorkerSourceMapsEnabled({
      POSTHOG_UPLOAD_SOURCEMAPS: "1",
      POSTHOG_SERVER_ERRORS_ENABLED: "1",
    }),
  ).toBe(true);
  expect(
    uploadWorkerSourceMapsEnabled({
      POSTHOG_UPLOAD_SOURCEMAPS: "1",
      NEXT_PUBLIC_POSTHOG_ENABLED: "1",
    }),
  ).toBe(true);
});

test("source maps are checked for build credentials including escaped source content", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tidy-map-privacy-"));
  const secret = "private-key-with-\n-newline";
  try {
    await mkdir(path.join(directory, "nested"));
    await writeFile(
      path.join(directory, "nested/worker.js.map"),
      JSON.stringify({ sourcesContent: [secret] }),
    );
    await expect(assertNoCredentials(directory, { POSTHOG_API_KEY: secret })).rejects.toThrow(
      "Private credential found",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential scan catches access keys, auth configuration and provider credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tidy-map-credential-names-"));
  const secret = "synthetic-private-provider-credential";
  try {
    await writeFile(path.join(directory, "worker.js.map"), secret);
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "DOCKER_AUTH_CONFIG",
      "STRIPE_KEY",
      "REGISTRY_AUTH",
      "NPM_CONFIG__AUTH",
      "AUTHORIZATION",
      "GCP_CREDENTIALS",
      "CLOUDFLARE_API_KEY",
    ]) {
      await expect(assertNoCredentials(directory, { [name]: secret })).rejects.toThrow(
        "Private credential found",
      );
    }
    // Public project keys and the public auth origin are not credentials.
    await assertNoCredentials(directory, {
      NEXT_PUBLIC_POSTHOG_KEY: secret,
      BETTER_AUTH_URL: secret,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact symlinks cannot bypass the credential scan", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tidy-map-symlink-"));
  try {
    await mkdir(path.join(directory, "deploy"));
    await writeFile(path.join(directory, "private.js.map"), "private-source");
    await symlink("../private.js.map", path.join(directory, "deploy/worker.js.map"));
    await expect(assertNoCredentials(path.join(directory, "deploy"), {})).rejects.toThrow(
      "Symlink in deployment artifacts",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty or mismatched source maps fail before upload", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tidy-map-validation-"));
  const entry = path.join(directory, "worker.js");
  try {
    await writeFile(entry, "//# sourceMappingURL=worker.js.map\n");
    await writeFile(`${entry}.map`, JSON.stringify({ version: 3, mappings: "", sources: [] }));
    await expect(validateWorkerSourceMap(entry)).rejects.toThrow("missing code mappings");
    await writeFile(
      `${entry}.map`,
      JSON.stringify({
        version: 3,
        mappings: "AAAA",
        sources: ["file.ts"],
        sourcesContent: ["throw Error()"],
        chunk_id: crypto.randomUUID(),
      }),
    );
    await expect(validateWorkerSourceMap(entry, { injected: true })).rejects.toThrow(
      "do not share",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("upload requires explicit credentials, release and a non-dry-run CLI", async () => {
  const options = {
    directory: "/unused",
    release: "release",
    env: {},
    run: () => {
      throw new Error("must not execute");
    },
  };
  await expect(uploadWorkerSourceMaps(options)).rejects.toThrow("POSTHOG_API_KEY");
  await expect(
    uploadWorkerSourceMaps({
      ...options,
      release: "",
      env: { POSTHOG_API_KEY: "synthetic", POSTHOG_PROJECT_ID: "1" },
    }),
  ).rejects.toThrow("built app version");
  await expect(
    uploadWorkerSourceMaps({
      ...options,
      env: { POSTHOG_API_KEY: "synthetic", POSTHOG_PROJECT_ID: "1", POSTHOG_CLI_DRY_RUN: "true" },
    }),
  ).rejects.toThrow("cannot be used");
});

test("provider upload failures propagate so deployment cannot continue", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tidy-map-upload-"));
  const chunkId = crypto.randomUUID();
  try {
    await writeFile(
      path.join(directory, "worker.js"),
      `globalThis._posthogChunkIds = {};\n//# sourceMappingURL=worker.js.map\n//# chunkId=${chunkId}\n`,
    );
    await writeFile(
      path.join(directory, "worker.js.map"),
      JSON.stringify({
        version: 3,
        mappings: "AAAA",
        sources: ["worker.ts"],
        sourcesContent: ["export default {}"],
        chunk_id: chunkId,
      }),
    );
    await expect(
      uploadWorkerSourceMaps({
        directory,
        release: "built-release",
        env: { POSTHOG_API_KEY: "phx_synthetic", POSTHOG_PROJECT_ID: "1" },
        run: (_script: string, args: string[]) => {
          if (args[1] === "upload") throw new Error("Provider rejected source maps");
        },
      }),
    ).rejects.toThrow("Provider rejected source maps");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
