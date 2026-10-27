-- Identifier-free server counters, separate from optional desktop analytics receipts/events.
begin;
create table "desktopServiceMetric" (
  day date not null,
  operation text not null check (operation in (
    'account','manifest','catalog','file_list','file_create','file_read',
    'file_commit','file_rename','asset_read','asset_write','thumbnail','creator_avatar'
  )),
  outcome text not null check (outcome in (
    'success','not_modified','invalid_request','unauthorized','forbidden','missing',
    'conflict','too_large','rate_limited','unavailable','server_error','other'
  )),
  latency text not null check (latency in ('under_100ms','under_1s','under_5s','under_20s','over_20s')),
  samples bigint not null check (samples>0),
  primary key(day,operation,outcome,latency)
);
commit;
