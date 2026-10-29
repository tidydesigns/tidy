-- Depends on schema-design-document.sql. Receipts share designImport's ownership,
-- quota and expiry; they contain result metadata, never captured pixels or cookies.
begin;
alter table "designImport"
  add column if not exists "requestHash" text,
  add column if not exists "requestResult" jsonb;
alter table "designImport" drop constraint if exists "designImport_requestHash_check";
alter table "designImport" add constraint "designImport_requestHash_check"
  check ("requestHash" is null or "requestHash" ~ '^[a-f0-9]{64}$');
commit;
