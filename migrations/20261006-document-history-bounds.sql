-- Deploy with the revision-bound edit protocol. Existing documents are preserved;
-- pre-deployment retries and undo history must resynchronize instead of replaying.
begin;
alter table "designRealtimeState" add column if not exists "replayFloorRevision" integer not null default 0;
alter table "designRealtimeState" add column if not exists "historyFloorSequence" bigint not null default 0;
alter table "designRealtimeOperation" add column if not exists "requestRevision" integer;
alter table "designRealtimeOperation" add column if not exists "byteSize" integer
  generated always as (octet_length("patch"::text) + 256) stored;
-- Only reset legacy receipts once. A rerun must not discard current-protocol edits.
do $$
begin
  if exists (select 1 from "designRealtimeOperation" where "requestRevision" is null) then
    update "designDocument" d set "revision" = d."revision" + 1
      where exists (select 1 from "designRealtimeOperation" o where o."fileId"=d."fileId" and o."requestRevision" is null);
    update "designRealtimeState" s set "replayFloorRevision"=greatest(s."replayFloorRevision", d."revision")
      from "designDocument" d where d."fileId"=s."fileId"
      and exists (select 1 from "designRealtimeOperation" o where o."fileId"=d."fileId" and o."requestRevision" is null);
    delete from "designRealtimeOperation" where "requestRevision" is null;
  end if;
end $$;
alter table "designRealtimeOperation" alter column "requestRevision" set not null;
create index if not exists "designRealtimeOperation_retention_idx"
  on "designRealtimeOperation" ("fileId", "revision" desc);

-- Every event producer uses this function, including comments and MCP mutations.
create or replace function bella_file_event(file_id text, event_kind text) returns void language plpgsql as $$
declare next_sequence bigint;
begin
  if file_id is null or not exists (select 1 from "designFile" where "id" = file_id) then return; end if;
  insert into "designRealtimeState" ("fileId", "sequence") values (file_id, 1)
    on conflict ("fileId") do update set "sequence" = "designRealtimeState"."sequence" + 1
    returning "sequence" into next_sequence;
  insert into "designRealtimeEvent" ("fileId", "sequence", "kind") values (file_id, next_sequence, event_kind);
  delete from "designRealtimeEvent" where "fileId"=file_id and "sequence" <= next_sequence - 2000;
end;
$$;

create index if not exists "designRealtimeProperty_retention_idx"
  on "designRealtimeProperty" ("fileId", "sequence" desc);
create or replace function tidy_prune_document_properties(file_id text) returns void language plpgsql as $$
begin
  -- Runs after bella_document_event has recorded paths. Discarded conflict markers
  -- advance a monotonic floor checked by conditional undo before examining paths.
  with ranked as (
    select ctid as row_id, "sequence",
      row_number() over (order by "sequence" desc, "collection", "entityId", "path") as position
    from "designRealtimeProperty" where "fileId"=file_id
  ), removed as (
    delete from "designRealtimeProperty" p using ranked r, "designRealtimeState" s
    where p."fileId"=file_id and s."fileId"=p."fileId"
      and p.ctid=r.row_id
      and (r.position > 20000 or r."sequence" <= s."sequence" - 2000)
    returning p."sequence"
  )
  update "designRealtimeState" set "historyFloorSequence"=greatest("historyFloorSequence", (select max("sequence") from removed))
    where "fileId"=file_id;
end;
$$;
create or replace function tidy_retain_document_properties() returns trigger language plpgsql as $$
begin
  perform tidy_prune_document_properties(new."fileId");
  return new;
end;
$$;
drop trigger if exists tidy_document_history on "designDocument";
create trigger tidy_document_history after insert or update of "content", "revision" on "designDocument"
  for each row execute function tidy_retain_document_properties();
-- Bring dormant files under the same bounds; no document contents are rewritten.
delete from "designRealtimeEvent" e using "designRealtimeState" s
  where e."fileId"=s."fileId" and e."sequence" <= s."sequence" - 2000;
select tidy_prune_document_properties("fileId") from "designRealtimeState";
commit;
