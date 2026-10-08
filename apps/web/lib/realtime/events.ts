/** Internal room outbox read. A retention gap invalidates every view at the current sequence. */
export const fileEventsQuery = `with events as (
  select "sequence", "kind" from "designRealtimeEvent"
  where "fileId"=$1 and "sequence">$2 order by "sequence" limit 200
), gap as (
  select "sequence" from "designRealtimeState" where "fileId"=$1 and "sequence">$2
    and coalesce((select min("sequence") from events), "sequence"+1)>$2+1
)
select "sequence", "kind" from events where not exists (select 1 from gap)
union all
select gap."sequence", kind from gap cross join unnest(array['document','metadata','comments']) as kind
order by "sequence"`;
