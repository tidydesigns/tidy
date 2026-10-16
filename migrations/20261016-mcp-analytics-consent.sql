-- Apply after 20261015-analytics-consent.sql, then reapply runtime-grants.sql.
begin;
create table "mcpAnalyticsConsent" (
  id uuid primary key,
  "userId" text not null references "user"(id) on delete cascade,
  enabled boolean not null,
  "noticeVersion" text not null,
  "createdAt" timestamptz not null default clock_timestamp(),
  "expiresAt" timestamptz not null,
  "retiredAt" timestamptz
);
create unique index "mcpAnalyticsConsent_current" on "mcpAnalyticsConsent" ("userId") where "retiredAt" is null;
create index "mcpAnalyticsConsent_expiry" on "mcpAnalyticsConsent" ("expiresAt") where "retiredAt" is null;
commit;
