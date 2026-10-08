// A disposable, localhost-only fixture. Never reads the application's production env.
import { readFile } from "node:fs/promises";
import pg from "pg";
const connectionString = process.env.MULTIPLAYER_TEST_DATABASE_URL;
if (!connectionString || !["127.0.0.1", "localhost"].includes(new URL(connectionString).hostname))
  throw new Error("Set MULTIPLAYER_TEST_DATABASE_URL to a disposable localhost database.");
const client = new pg.Client({ connectionString });
await client.connect();
try {
  for (const name of [
    "schema.sql",
    "schema-organization.sql",
    "schema-vault.sql",
    "schema-mcp.sql",
    "schema-design-files.sql",
    "schema-design-rectangles.sql",
    "schema-design-folders.sql",
    "schema-design-document.sql",
    "schema-design-comments.sql",
    "schema-design-comment-reactions.sql",
    "schema-github.sql",
    "20261005-connectors.sql",
    "20260928-file-multiplayer.sql",
    "20261002-comment-thread-resolution.sql",
    "20260929-organization-billing.sql",
    "20261002-feedback-images.sql",
    "20261003-design-object-storage.sql",
    "20261003-file-thumbnails.sql",
    "20261003-editor-change-deltas.sql",
    "20261003-plan-limits.sql",
    "20261006-mcp-call-limits.sql",
    "20261004-organization-creation-limit.sql",
    "20261006-thumbnail-storage-limits.sql",
    "20261006-document-history-bounds.sql",
    "20261007-github-history-limits.sql",
    "20261007-linear-operation-indexes.sql",
    "20261007-github-oauth-state-indexes.sql",
    "20261005-agent-threads.sql",
    "20261007-file-version-history.sql",
  ])
    await client.query(
      await readFile(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"),
    );
  console.log("Disposable multiplayer database schema initialized.");
} finally {
  await client.end();
}
