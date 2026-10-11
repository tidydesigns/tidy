-- Preserve durable collaboration events and conflict paths while avoiding
-- recursive calls for unchanged properties and one INSERT per changed path.
-- Apply after 20260928-file-multiplayer.sql. No production application is implicit.
begin;

-- Recursive JSON estimates can cross the JIT threshold even for tiny writes.
-- Compile-free execution is scoped to this trigger; callers retain their setting.
create or replace function bella_document_event() returns trigger language plpgsql set jit=off as $$
declare prior jsonb; event_sequence bigint;
begin
  if TG_OP = 'INSERT' then prior := '{}'::jsonb; else prior := old."content"; end if;
  perform bella_file_event(new."fileId", 'document');
  select "sequence" into event_sequence from "designRealtimeState" where "fileId" = new."fileId";

  -- Walk changed entities together. Unchanged branches never enter the work
  -- table; arrays/scalars/null/missing values remain atomic conflict paths.
  with recursive changes(collection, entity_id, path, before_value, after_value) as (
    select collection.name, changed.entity_id, '{}'::text[],
           changed.before_entity, changed.after_entity
    from unnest(array['nodes','pages']) collection(name)
    cross join lateral (
      select coalesce(b.value ->> 'id', a.value ->> 'id') as entity_id,
             b.value as before_entity, a.value as after_entity
      from jsonb_array_elements(coalesce(prior -> collection.name, '[]'::jsonb)) b
      full outer join jsonb_array_elements(coalesce(new."content" -> collection.name, '[]'::jsonb)) a
        on b.value ->> 'id' = a.value ->> 'id'
      where b.value is distinct from a.value
    ) changed
    union all
    select 'document', '', '{}'::text[],
           prior - 'nodes' - 'pages' - 'commentPages',
           new."content" - 'nodes' - 'pages' - 'commentPages'
    where prior - 'nodes' - 'pages' - 'commentPages' is distinct from
          new."content" - 'nodes' - 'pages' - 'commentPages'
    union all
    select changes.collection, changes.entity_id, changes.path || child.key,
           child.before_value, child.after_value
    from changes
    cross join lateral (
      select coalesce(b.key, a.key) as key, b.value as before_value, a.value as after_value
      from jsonb_each(case when jsonb_typeof(changes.before_value)='object'
                          and jsonb_typeof(changes.after_value)='object'
                     then changes.before_value else '{}'::jsonb end) b
      full outer join jsonb_each(case when jsonb_typeof(changes.before_value)='object'
                                     and jsonb_typeof(changes.after_value)='object'
                                then changes.after_value else '{}'::jsonb end) a using (key)
      where b.value is distinct from a.value
    ) child
  )
  insert into "designRealtimeProperty" ("fileId","collection","entityId","path","sequence")
  select new."fileId", collection, entity_id, path, event_sequence from changes
  where (jsonb_typeof(before_value)='object' and jsonb_typeof(after_value)='object') is not true
  on conflict ("fileId","collection","entityId","path")
    do update set "sequence" = excluded."sequence";
  return new;
end;
$$;
commit;
