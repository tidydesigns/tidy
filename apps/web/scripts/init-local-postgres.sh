#!/bin/sh
set -eu

# The official Postgres image runs this only when the local data volume is new.
# Keep this list in dependency order when adding migrations.
migrations_dir=${MIGRATIONS_DIR:-/migrations}
set --
for migration in \
  schema.sql \
  schema-organization.sql \
  schema-vault.sql \
  schema-mcp.sql \
  schema-design-files.sql \
  schema-design-rectangles.sql \
  schema-design-folders.sql \
  schema-design-document.sql \
  schema-design-comments.sql \
  schema-design-comment-reactions.sql \
  schema-github.sql \
  20261005-connectors.sql \
  20260928-file-multiplayer.sql \
  20260929-organization-billing.sql \
  20261002-feedback-images.sql \
  20261002-comment-thread-resolution.sql \
  20261003-design-object-storage.sql \
  20261003-file-thumbnails.sql \
  20261003-editor-change-deltas.sql \
  20261003-plan-limits.sql \
  20261004-organization-creation-limit.sql \
  20261006-mcp-call-limits.sql \
  20261006-thumbnail-storage-limits.sql \
  20261006-document-history-bounds.sql \
  20261007-github-history-limits.sql \
  20261007-linear-operation-indexes.sql \
  20261007-github-oauth-state-indexes.sql \
  20261005-agent-threads.sql \
  20261007-file-version-history.sql
do
  set -- "$@" -f "$migrations_dir/$migration"
done

psql -X -v ON_ERROR_STOP=1 --single-transaction \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"
