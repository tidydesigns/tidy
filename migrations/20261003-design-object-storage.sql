-- Prepare only. Apply to the approved database before deploying this version.
begin;
create table if not exists "designObject" (
  "objectKey" text primary key,
  "organizationId" text not null,
  "mimeType" text not null,
  "sha256" text not null,
  "byteSize" bigint not null,
  "lastClaimedAt" timestamptz not null default now()
);
create index if not exists "designObject_gc_idx" on "designObject" ("lastClaimedAt");
alter table "designAsset" add column if not exists "objectKey" text;
alter table "designAsset" add column if not exists "byteSize" bigint;
alter table "designAsset" alter column "body" drop not null;
update "designAsset" set "byteSize" = octet_length("body") where "byteSize" is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='designAsset_storage_check' and conrelid='"designAsset"'::regclass) then
    alter table "designAsset" add constraint "designAsset_storage_check" check ("body" is not null or "objectKey" is not null);
  end if;
end $$;
create index if not exists "designAsset_object_idx" on "designAsset" ("objectKey") where "objectKey" is not null;

alter table "githubReviewAsset" add column if not exists "objectKey" text;
alter table "githubReviewAsset" add column if not exists "byteSize" bigint;
alter table "githubReviewAsset" add column if not exists "sha256" text;
alter table "githubReviewAsset" alter column "body" drop not null;
update "githubReviewAsset" set "byteSize" = octet_length("body") where "byteSize" is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='githubReviewAsset_storage_check' and conrelid='"githubReviewAsset"'::regclass) then
    alter table "githubReviewAsset" add constraint "githubReviewAsset_storage_check" check ("body" is not null or "objectKey" is not null);
  end if;
end $$;
create index if not exists "githubReviewAsset_object_idx" on "githubReviewAsset" ("objectKey") where "objectKey" is not null;

alter table "githubCapture" add column if not exists "objectKey" text;
alter table "githubCapture" add column if not exists "byteSize" bigint;
alter table "githubCapture" alter column "body" drop not null;
update "githubCapture" set "byteSize" = octet_length("body") where "byteSize" is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='githubCapture_storage_check' and conrelid='"githubCapture"'::regclass) then
    alter table "githubCapture" add constraint "githubCapture_storage_check" check ("body" is not null or "objectKey" is not null);
  end if;
end $$;
create index if not exists "githubCapture_object_idx" on "githubCapture" ("objectKey") where "objectKey" is not null;
commit;
