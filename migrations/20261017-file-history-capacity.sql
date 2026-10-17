-- Apply after file-version history and account privacy. Backfill preserves existing
-- versions; later admissions roll older unnamed history within these ceilings.
begin;
create table "organizationHistoryUsage" (
  "organizationId" text primary key references "organization" ("id") on delete cascade,
  "bytes" bigint not null default 0 check ("bytes" >= 0)
);
create table "fileHistoryUsage" (
  "fileId" text primary key references "designFile" ("id") on delete cascade,
  "versions" integer not null default 0 check ("versions" >= 0),
  "bytes" bigint not null default 0 check ("bytes" >= 0)
);
alter table "designFileVersion" add column "byteSize" bigint
  generated always as (octet_length("content"::text)::bigint + 512) stored;

-- A derived workspace key makes bounded rolling-history selection indexable.
alter table "designFileVersion" add column "organizationId" text;
update "designFileVersion" v set "organizationId"=f."organizationId" from "designFile" f where f."id"=v."fileId";
alter table "designFileVersion" alter column "organizationId" set not null;
create index "file_history_rolling" on "designFileVersion" ("fileId", "sequence") where "kind" <> 'named';
create index "workspace_history_rolling" on "designFileVersion" ("organizationId", "sequence") where "kind" <> 'named';

insert into "fileHistoryUsage" ("fileId", "versions", "bytes")
  select "fileId", count(*)::integer, sum("byteSize") from "designFileVersion" group by "fileId";
insert into "organizationHistoryUsage" ("organizationId", "bytes")
  select f."organizationId", sum(v."byteSize") from "designFileVersion" v
    join "designFile" f on f."id"=v."fileId" group by f."organizationId";

-- Serialize admission on dedicated accounting rows, using their current values
-- after waiting. Workspace pruning skips files held by another editor.
create function "admitFileVersion"() returns trigger language plpgsql as $$
declare
  organization_id text;
  workspace_bytes bigint;
  file_bytes bigint;
  file_versions integer;
  incoming_bytes bigint := octet_length(NEW."content"::text)::bigint + 512;
  victim record;
  removed integer := 0;
  protected_versions uuid[] := coalesce(nullif(current_setting('tidy.history_protected_versions', true), '')::uuid[], '{}');
begin
  select "organizationId" into strict organization_id from "designFile" where "id"=NEW."fileId" for share;
  NEW."organizationId" := organization_id;
  insert into "organizationHistoryUsage" ("organizationId") values (organization_id) on conflict do nothing;
  select "bytes" into workspace_bytes from "organizationHistoryUsage"
    where "organizationId"=organization_id for update;
  insert into "fileHistoryUsage" ("fileId") values (NEW."fileId") on conflict do nothing;
  select "versions", "bytes" into file_versions, file_bytes from "fileHistoryUsage"
    where "fileId"=NEW."fileId" for update;
  -- An idempotent insert must not prune anything before ON CONFLICT resolves it.
  if exists (select 1 from "designFileVersion" where "id"=NEW."id") then return NEW; end if;
  -- Keep in sync with FILE_HISTORY_LIMITS. Named versions are never evicted.
  -- Roll automatic/pre-restore versions oldest first, with bounded work per call.
  while incoming_bytes <= 128000000 and removed < 200 and
    (file_versions >= 200 or file_bytes + incoming_bytes > 128000000
      or workspace_bytes + incoming_bytes > 1000000000) loop
    if file_versions >= 200 or file_bytes + incoming_bytes > 128000000 then
      select v."id",v."fileId",v."byteSize" into victim from "designFileVersion" v
        where v."fileId"=NEW."fileId" and v."kind" <> 'named'
          and v."id" <> all(protected_versions)
        order by v."sequence" limit 1 for update of v skip locked;
    else
      -- Other editors may hold their file locks while awaiting this workspace's
      -- accounting row. Skip those files and versions instead of reversing locks.
      select v."id",v."fileId",v."byteSize" into victim from "designFileVersion" v
        join "designFile" f on f."id"=v."fileId"
        where v."organizationId"=organization_id and v."kind" <> 'named'
          and v."id" <> all(protected_versions)
        order by v."sequence" limit 1 for share of f skip locked for update of v skip locked;
    end if;
    exit when not found;
    delete from "designFileVersion" where "id"=victim."id";
    workspace_bytes := workspace_bytes-victim."byteSize";
    if victim."fileId"=NEW."fileId" then
      file_versions := file_versions-1;
      file_bytes := file_bytes-victim."byteSize";
    end if;
    removed := removed+1;
  end loop;
  if file_versions >= 200 or file_bytes + incoming_bytes > 128000000
    or workspace_bytes + incoming_bytes > 1000000000 then
    if NEW."kind"='automatic' then return null; end if;
    raise exception using errcode='P0001', message='file_history_capacity';
  end if;
  return NEW;
end;
$$;
create trigger "admit_file_version" before insert on "designFileVersion"
  for each row execute function "admitFileVersion"();

create function "accountFileVersion"() returns trigger language plpgsql as $$
declare organization_id text;
begin
  if TG_OP='INSERT' then
    select "organizationId" into organization_id from "designFile" where "id"=NEW."fileId";
    update "organizationHistoryUsage" set "bytes"="bytes"+NEW."byteSize" where "organizationId"=organization_id;
    update "fileHistoryUsage" set "versions"="versions"+1, "bytes"="bytes"+NEW."byteSize" where "fileId"=NEW."fileId";
    return NEW;
  end if;
  -- Parent deletion may already have cascaded its accounting row away.
  select "organizationId" into organization_id from "designFile" where "id"=OLD."fileId" for share;
  if organization_id is null then return OLD; end if;
  update "organizationHistoryUsage" set "bytes"="bytes"-OLD."byteSize" where "organizationId"=organization_id;
  update "fileHistoryUsage" set "versions"="versions"-1, "bytes"="bytes"-OLD."byteSize" where "fileId"=OLD."fileId";
  return OLD;
end;
$$;
create trigger "account_file_version" after insert or delete on "designFileVersion"
  for each row execute function "accountFileVersion"();

create function "immutableFileVersionContent"() returns trigger language plpgsql as $$
begin
  if NEW."fileId" is distinct from OLD."fileId" or NEW."content" is distinct from OLD."content"
    or NEW."organizationId" is distinct from (select "organizationId" from "designFile" where "id"=NEW."fileId") then
    raise exception 'File version content is immutable';
  end if;
  return NEW;
end;
$$;
create trigger "immutable_file_version_content" before update on "designFileVersion"
  for each row execute function "immutableFileVersionContent"();
-- Release aggregate usage before a file disappears; cascaded child deletions
-- can no longer resolve the parent and deliberately do not charge it twice.
create function "releaseFileHistory"() returns trigger language plpgsql as $$
begin
  -- Workspace deletion also cascades its usage row; do not update that row
  -- after its foreign-key parent has disappeared.
  if not exists (select 1 from "organization" where "id"=OLD."organizationId") then return OLD; end if;
  update "organizationHistoryUsage" set "bytes"="bytes"-coalesce(
    (select "bytes" from "fileHistoryUsage" where "fileId"=OLD."id"), 0)
    where "organizationId"=OLD."organizationId";
  return OLD;
end;
$$;
create trigger "release_file_history" before delete on "designFile"
  for each row execute function "releaseFileHistory"();

create function "transferFileHistory"() returns trigger language plpgsql as $$
declare
  history_bytes bigint;
  destination_bytes bigint;
begin
  if NEW."organizationId" is not distinct from OLD."organizationId" then return NEW; end if;
  -- The file row lock serializes moves with history admission. Always acquire
  -- both workspace counters in the same order, including when creating them.
  insert into "organizationHistoryUsage" ("organizationId")
    select id from unnest(array[OLD."organizationId", NEW."organizationId"]) as ids(id)
    order by id on conflict do nothing;
  perform 1 from "organizationHistoryUsage"
    where "organizationId" in (OLD."organizationId", NEW."organizationId")
    order by "organizationId" for update;
  select coalesce((select "bytes" from "fileHistoryUsage" where "fileId"=OLD."id"), 0) into history_bytes;
  select "bytes" into destination_bytes from "organizationHistoryUsage" where "organizationId"=NEW."organizationId";
  if history_bytes > 0 and destination_bytes + history_bytes > 1000000000 then
    raise exception using errcode='P0001', message='file_history_capacity';
  end if;
  update "organizationHistoryUsage" set "bytes"="bytes"-history_bytes where "organizationId"=OLD."organizationId";
  update "organizationHistoryUsage" set "bytes"="bytes"+history_bytes where "organizationId"=NEW."organizationId";
  return NEW;
end;
$$;
create trigger "transfer_file_history" before update of "organizationId" on "designFile"
  for each row execute function "transferFileHistory"();
create function "moveFileHistoryIndex"() returns trigger language plpgsql as $$
begin
  if NEW."organizationId" is distinct from OLD."organizationId" then
    update "designFileVersion" set "organizationId"=NEW."organizationId" where "fileId"=NEW."id";
  end if;
  return NEW;
end;
$$;
create trigger "move_file_history_index" after update of "organizationId" on "designFile"
  for each row execute function "moveFileHistoryIndex"();
commit;
