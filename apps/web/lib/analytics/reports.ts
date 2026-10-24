// Read-only, bounded report definitions shared by maintenance and the operator CLI.
export const activityReport = `select surface,name,properties->>'harness' as harness,count(*)::int as events,count(distinct subject)::int as installations
from "productAnalyticsEvent" where purpose='usage' and "expiresAt">clock_timestamp() and at>=current_date-90
group by surface,name,properties->>'harness' order by surface,name,harness`;
export const retentionReport = `with active as (
 select distinct subject,surface,(at at time zone 'UTC')::date as day from "productAnalyticsEvent"
 where name='product_active_day' and purpose='usage' and "expiresAt">clock_timestamp() and at>=current_date-90
), cohorts as (select subject,surface,min(day) as day from active group by subject,surface)
select c.day::text,c.surface,count(*)::int as size,
 count(*) filter(where exists(select 1 from active a where a.subject=c.subject and a.surface=c.surface and a.day=c.day+1))::int as d1,
 count(*) filter(where exists(select 1 from active a where a.subject=c.subject and a.surface=c.surface and a.day=c.day+7))::int as d7,
 count(*) filter(where exists(select 1 from active a where a.subject=c.subject and a.surface=c.surface and a.day=c.day+30))::int as d30
from cohorts c group by c.day,c.surface order by c.day,c.surface`;
export const linkedReport = `select surface,count(distinct "accountId")::int as accounts from "productAnalyticsEvent" where "accountId" is not null and purpose='usage' and name='product_active_day' and "expiresAt">clock_timestamp() and at>=current_date-30 group by surface`;
export const versionsReport = `with latest as (select distinct on(subject) subject,properties from "productAnalyticsEvent" where surface='desktop' and name='product_active_day' and "expiresAt">clock_timestamp() and at>=current_date-7 order by subject,at desc) select properties->>'release' as release,properties->>'arch' as arch,count(*)::int as installations from latest group by properties->>'release',properties->>'arch'`;
export const diagnosticsReport = `select name,properties->>'result' as result,properties->>'operation' as operation,count(*)::int as reports from "productAnalyticsEvent" where purpose='diagnostics' and "expiresAt">clock_timestamp() group by name,properties->>'result',properties->>'operation'`;
export const downloadReport = `select day::text,release,kind,sum(downloads)::bigint::text as cumulative from "desktopDownloadSnapshot" where day>=current_date-90 group by day,release,kind order by day,release,kind`;
export const downloadDeltaReport = `with daily as (select day,release,kind,sum(downloads) as cumulative from "desktopDownloadSnapshot" group by day,release,kind) select day::text,release,kind,cumulative::text,(cumulative-lag(cumulative) over(partition by release,kind order by day))::text as delta from daily order by day,release,kind`;
export const weeklyRetentionReport = `with active as (select distinct subject,surface,date_trunc('week',at at time zone 'UTC')::date as week from "productAnalyticsEvent" where name='product_active_day' and purpose='usage' and "expiresAt">clock_timestamp()), cohorts as (select subject,surface,min(week) as week from active group by subject,surface) select c.week::text,c.surface,count(*)::int as size,count(*) filter(where exists(select 1 from active a where a.subject=c.subject and a.surface=c.surface and a.week=c.week+7))::int as w1,count(*) filter(where exists(select 1 from active a where a.subject=c.subject and a.surface=c.surface and a.week=c.week+28))::int as w4 from cohorts c group by c.week,c.surface order by c.week,c.surface`;
export const accountRetentionReport = retentionReport
  .replace(
    "select distinct subject,surface,",
    "select distinct \"accountId\"::text as subject,'linked_account' as surface,",
  )
  .replace(
    "where name='product_active_day'",
    "where \"accountId\" is not null and name='product_active_day'",
  );
