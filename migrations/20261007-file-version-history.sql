-- Apply after document, multiplayer and object-storage migrations.
begin;

create table "designFileVersion" (
  "id" uuid primary key default gen_random_uuid(),
  "sequence" bigint generated always as identity unique,
  "fileId" text not null references "designFile" ("id") on delete cascade,
  "revision" integer not null,
  "content" jsonb not null,
  "name" text check (char_length("name") between 1 and 120),
  "kind" text not null check ("kind" in ('automatic', 'named', 'beforeRestore')),
  "createdBy" text references "user" ("id") on delete set null,
  "createdByName" text,
  "createdAt" timestamptz not null default clock_timestamp(),
  unique ("fileId", "id")
);
create index "designFileVersion_file_order_idx" on "designFileVersion" ("fileId", "sequence" desc);
create index "designFileVersion_automatic_idx" on "designFileVersion" ("fileId", "sequence" desc)
  where "kind" = 'automatic';

-- Keep immutable originals referenced by historical documents, including hidden variants.
-- Deferred checks allow an organization/file deletion to cascade in either FK order.
create table "designFileVersionAsset" (
  "versionId" uuid not null references "designFileVersion" ("id") on delete cascade,
  "assetId" text not null references "designAsset" ("id") deferrable initially deferred,
  primary key ("versionId", "assetId")
);
create table "designFileRestore" (
  "fileId" text not null references "designFile" ("id") on delete cascade,
  "operationId" uuid not null,
  "restoredVersionId" uuid not null,
  "beforeVersionId" uuid not null,
  "createdBy" text references "user" ("id") on delete set null,
  "createdByName" text,
  "revision" integer not null,
  "createdAt" timestamptz not null default clock_timestamp(),
  primary key ("fileId", "operationId"),
  foreign key ("fileId", "restoredVersionId") references "designFileVersion" ("fileId", "id") on delete cascade,
  foreign key ("fileId", "beforeVersionId") references "designFileVersion" ("fileId", "id") on delete cascade
);

create function "pinFileVersionAssets"() returns trigger language plpgsql as $$
begin
  insert into "designFileVersionAsset" ("versionId", "assetId")
  select distinct NEW."id", a."id" from "designAsset" a
    join "designFile" f on f."organizationId"=a."organizationId" and f."id"=NEW."fileId"
    join jsonb_path_query(NEW."content", '$.**.assetId') source(value) on a."id"=source.value #>> '{}';
  return NEW;
end;
$$;
create trigger "pin_file_version_assets" after insert on "designFileVersion"
  for each row execute function "pinFileVersionAssets"();

-- Time-based history covers every write path (editor, imports and MCP).
-- Named checkpoints and pre-restore checkpoints are additional immutable versions.
create function "captureFileVersion"() returns trigger language plpgsql as $$
begin
  if TG_OP='UPDATE' and NEW."revision"=OLD."revision" then return NEW; end if;
  if not exists (select 1 from "designFileVersion" where "fileId"=NEW."fileId" and "kind"='automatic'
    and "createdAt">clock_timestamp()-interval '5 minutes') then
    insert into "designFileVersion" ("fileId","revision","content","kind")
      values (NEW."fileId", NEW."revision", NEW."content", 'automatic');
  end if;
  return NEW;
end;
$$;
create trigger "capture_file_version" after insert or update on "designDocument"
  for each row execute function "captureFileVersion"();

insert into "designFileVersion" ("fileId","revision","content","kind")
  select "fileId","revision","content",'automatic' from "designDocument";
commit;
