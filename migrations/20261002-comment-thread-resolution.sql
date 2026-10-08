-- Apply after schema-design-comments.sql and before deploying comment resolution.
-- Existing threads remain open. The multiplayer trigger publishes status changes.
alter table "designCommentThread"
  add column if not exists "resolved" boolean not null default false;
