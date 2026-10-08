-- Apply after 20261003-plan-limits.sql. Counters start at zero on rollout.
begin;

alter table "billingPlan" add column "mcpCallLimit" bigint
  check ("mcpCallLimit" between 0 and 9007199254740991);
update "billingPlan" set "mcpCallLimit" = 5000 where "id" = 'free';
update "billingPlan" set "mcpCallLimit" = 100000 where "id" = 'pro';

create table "organizationMcpUsage" (
  "organizationId" text not null references "organization"("id") on delete cascade,
  "periodStart" date not null,
  "calls" bigint not null default 0 check ("calls" between 0 and 9007199254740991),
  primary key ("organizationId", "periodStart")
);

-- A separate row per UTC calendar month makes resets automatic. The shared
-- organization lock serializes calls with each other and subscription changes.
create function "consumeOrganizationMcpCall"(actor text, org text) returns void language plpgsql as $$
declare tier text; allowance bigint; used bigint; period_start date;
begin
  perform pg_advisory_xact_lock(hashtextextended(org, 0));
  if not exists (select 1 from "member" where "organizationId" = org and "userId" = actor) then
    raise exception using errcode = '42501', message = 'Workspace not found or access denied.';
  end if;
  period_start := date_trunc('month', clock_timestamp() at time zone 'UTC')::date;
  tier := "organizationPlan"(org);
  select "mcpCallLimit" into allowance from "billingPlan" where "id" = tier;
  select "calls" into used from "organizationMcpUsage" where "organizationId" = org and "periodStart" = period_start;
  if allowance is not null and coalesce(used, 0) >= allowance then
    raise exception using errcode = 'P0001',
      message = format('%s allows %s MCP calls per month. Your allowance resets on %s (UTC).%s',
        initcap(tier), allowance, to_char(period_start + interval '1 month', 'FMMonth FMDD, YYYY'),
        case when tier = 'free' then ' Upgrade to Pro for more calls.' else '' end),
      detail = jsonb_build_object('code', 'PLAN_LIMIT', 'resource', 'mcpCalls', 'limit', allowance, 'tier', tier)::text;
  end if;
  insert into "organizationMcpUsage" ("organizationId", "periodStart", "calls") values (org, period_start, 1)
    on conflict ("organizationId", "periodStart") do update set "calls" = "organizationMcpUsage"."calls" + 1;
end;
$$;

create or replace function "organizationPlanUsage"(org text) returns jsonb language sql stable as $$
  select jsonb_build_object('tier', p."id",
    'limits', jsonb_build_object('files', p."fileLimit", 'editors', p."editorLimit", 'storageBytes', p."storageLimit", 'mcpCalls', p."mcpCallLimit"),
    'usage', jsonb_build_object('files', (select count(*) from "designFile" where "organizationId" = org),
      'editors', (select count(*) from "organizationEditors"(org)),
      'storageBytes', (select coalesce(sum(bytes), 0) from "organizationStorageObjects"(org)),
      'mcpCalls', (select coalesce((select "calls" from "organizationMcpUsage" where "organizationId" = org
        and "periodStart" = date_trunc('month', current_timestamp at time zone 'UTC')::date), 0))),
    'mcpResetAt', to_char(date_trunc('month', current_timestamp at time zone 'UTC') + interval '1 month', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  from "billingPlan" p where p."id" = "organizationPlan"(org)
$$;

commit;
