-- Apply after 20261016-mcp-analytics-consent.sql, before the matching app release.
begin;
-- Anonymous choices are single-use intents, identified only by a hashed HttpOnly
-- token. Authentication assigns them to one account; they are never telemetry IDs
-- until that assignment. Existing account choices keep their original scope.
alter table "mcpAnalyticsConsent" alter column "userId" drop not null;
alter table "mcpAnalyticsConsent" add column "intentTokenHash" text;
-- Reaffirming a choice must defeat an older pending decision without renewing
-- the original collection period.
alter table "mcpAnalyticsConsent" add column "lastChosenAt" timestamptz;
update "mcpAnalyticsConsent" set "lastChosenAt"="createdAt";
alter table "mcpAnalyticsConsent" alter column "lastChosenAt" set default clock_timestamp();
alter table "mcpAnalyticsConsent" alter column "lastChosenAt" set not null;
alter table "mcpAnalyticsConsent" add constraint "mcpAnalyticsConsent_subject"
  check ("userId" is not null or "intentTokenHash" is not null);
alter table "mcpAnalyticsConsent" add constraint "mcpAnalyticsConsent_intent_hash"
  check ("intentTokenHash" is null or "intentTokenHash" ~ '^[a-f0-9]{64}$');
create unique index "mcpAnalyticsConsent_intent" on "mcpAnalyticsConsent" ("intentTokenHash")
  where "intentTokenHash" is not null;
commit;
