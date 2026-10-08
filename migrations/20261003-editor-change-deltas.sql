-- Pair canonical operation patches with the exact document revisions they span.
-- Existing operations keep null revisions and trigger snapshot fallback.
begin;
alter table "designRealtimeOperation" add column if not exists "baseRevision" integer;
alter table "designRealtimeOperation" add column if not exists "revision" integer;
create index if not exists "designRealtimeOperation_revision_idx"
  on "designRealtimeOperation" ("fileId", "revision")
  where "revision" is not null and jsonb_array_length("patch") > 0;
commit;
