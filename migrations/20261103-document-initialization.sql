alter table "designDocument"
  add column if not exists "initialized" boolean
  generated always as (coalesce("content"->>'legacyConverted' = 'true', false)) stored;
