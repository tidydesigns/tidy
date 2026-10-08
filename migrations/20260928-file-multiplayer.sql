-- Apply only to an explicitly approved database. No production application is implicit.
begin;
create table if not exists "designRealtimeState" (
  "fileId" text primary key references "designFile"("id") on delete cascade,
  "sequence" bigint not null default 0
);
create table if not exists "designRealtimeEvent" (
  "fileId" text not null references "designFile"("id") on delete cascade,
  "sequence" bigint not null,
  "kind" text not null check ("kind" in ('document', 'metadata', 'comments')),
  "createdAt" timestamptz not null default now(),
  primary key ("fileId", "sequence")
);
create table if not exists "designRealtimeOperation" (
  "fileId" text not null references "designFile"("id") on delete cascade,
  "operationId" uuid not null,
  "userId" text not null,
  "hash" text not null,
  "patch" jsonb not null,
  "sequence" bigint not null default 0,
  "createdAt" timestamptz not null default now(),
  primary key ("fileId", "operationId")
);
alter table "designRealtimeOperation" add column if not exists "sequence" bigint not null default 0;
create table if not exists "designRealtimeProperty" (
  "fileId" text not null references "designFile"("id") on delete cascade,
  "collection" text not null,
  "entityId" text not null,
  "path" text[] not null,
  "sequence" bigint not null,
  primary key ("fileId", "collection", "entityId", "path")
);
create or replace function bella_changed_paths(before_value jsonb, after_value jsonb, prefix text[] default '{}'::text[]) returns setof text[] language plpgsql as $$
declare key text;
begin
  if before_value is not distinct from after_value then return; end if;
  if jsonb_typeof(before_value) = 'object' and jsonb_typeof(after_value) = 'object' then
    for key in select jsonb_object_keys(before_value) union select jsonb_object_keys(after_value) loop
      return query select * from bella_changed_paths(before_value -> key, after_value -> key, prefix || key);
    end loop;
  else return next prefix;
  end if;
end;
$$;
create or replace function bella_file_event(file_id text, event_kind text) returns void language plpgsql as $$
declare next_sequence bigint;
begin
  if file_id is null or not exists (select 1 from "designFile" where "id" = file_id) then return; end if;
  insert into "designRealtimeState" ("fileId", "sequence") values (file_id, 1)
    on conflict ("fileId") do update set "sequence" = "designRealtimeState"."sequence" + 1
    returning "sequence" into next_sequence;
  insert into "designRealtimeEvent" ("fileId", "sequence", "kind") values (file_id, next_sequence, event_kind);
end;
$$;
create or replace function bella_document_event() returns trigger language plpgsql as $$
declare prior jsonb; collection_name text; changed_entity record; changed_path text[]; event_sequence bigint;
begin
  if TG_OP = 'INSERT' then prior := '{}'::jsonb; else prior := old."content"; end if;
  perform bella_file_event(new."fileId", 'document');
  select "sequence" into event_sequence from "designRealtimeState" where "fileId" = new."fileId";
  for collection_name in select unnest(array['nodes','pages']) loop
    for changed_entity in
      select coalesce(b.value ->> 'id', a.value ->> 'id') as entity_id, b.value as before_entity, a.value as after_entity
      from jsonb_array_elements(coalesce(prior -> collection_name, '[]'::jsonb)) b
      full outer join jsonb_array_elements(coalesce(new."content" -> collection_name, '[]'::jsonb)) a on b.value ->> 'id' = a.value ->> 'id'
      where b.value is distinct from a.value loop
      for changed_path in select * from bella_changed_paths(changed_entity.before_entity, changed_entity.after_entity) loop
        insert into "designRealtimeProperty" ("fileId","collection","entityId","path","sequence") values (new."fileId",collection_name,changed_entity.entity_id,changed_path,event_sequence)
          on conflict ("fileId","collection","entityId","path") do update set "sequence" = excluded."sequence";
      end loop;
    end loop;
  end loop;
  for changed_path in select * from bella_changed_paths(prior - 'nodes' - 'pages' - 'commentPages', new."content" - 'nodes' - 'pages' - 'commentPages') loop
    insert into "designRealtimeProperty" ("fileId","collection","entityId","path","sequence") values (new."fileId",'document','',changed_path,event_sequence)
      on conflict ("fileId","collection","entityId","path") do update set "sequence" = excluded."sequence";
  end loop;
  return new;
end;
$$;
drop trigger if exists bella_document_event on "designDocument";
create trigger bella_document_event after insert or update on "designDocument" for each row execute function bella_document_event();
create or replace function bella_metadata_event() returns trigger language plpgsql as $$
begin
  if new."name" is distinct from old."name" or new."archivedAt" is distinct from old."archivedAt" then
    perform bella_file_event(new."id", 'metadata');
  end if;
  return new;
end;
$$;
drop trigger if exists bella_metadata_event on "designFile";
create trigger bella_metadata_event after update on "designFile" for each row execute function bella_metadata_event();
create or replace function bella_comment_event() returns trigger language plpgsql as $$
declare file_id text;
begin
  if TG_TABLE_NAME = 'designCommentThread' then
    if TG_OP = 'DELETE' then file_id := old."fileId"; else file_id := new."fileId"; end if;
  elsif TG_TABLE_NAME = 'designCommentMessage' then
    if TG_OP = 'DELETE' then
      select "fileId" into file_id from "designCommentThread" where "id" = old."threadId";
    else
      select "fileId" into file_id from "designCommentThread" where "id" = new."threadId";
    end if;
  else
    if TG_OP = 'DELETE' then
      select t."fileId" into file_id from "designCommentMessage" m join "designCommentThread" t on t."id" = m."threadId" where m."id" = old."messageId";
    else
      select t."fileId" into file_id from "designCommentMessage" m join "designCommentThread" t on t."id" = m."threadId" where m."id" = new."messageId";
    end if;
  end if;
  perform bella_file_event(file_id, 'comments');
  if TG_OP = 'DELETE' then return old; else return new; end if;
end;
$$;
drop trigger if exists bella_comment_event on "designCommentThread";
create trigger bella_comment_event after insert or update or delete on "designCommentThread" for each row execute function bella_comment_event();
drop trigger if exists bella_comment_event on "designCommentMessage";
create trigger bella_comment_event after insert or update or delete on "designCommentMessage" for each row execute function bella_comment_event();
-- Reactions are optional in older installations.
do $$ begin
  if to_regclass('public."designCommentReaction"') is not null then
    execute 'drop trigger if exists bella_comment_event on "designCommentReaction"';
    execute 'create trigger bella_comment_event after insert or update or delete on "designCommentReaction" for each row execute function bella_comment_event()';
  end if;
end $$;
commit;
