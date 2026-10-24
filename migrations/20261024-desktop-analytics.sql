-- Apply after 20261021-combined-privacy-consent.sql, then reapply runtime-grants.sql.
begin;
create table "productAnalyticsAccount" (
  id uuid primary key,
  "userId" text not null unique references "user"(id) on delete cascade
);
create table "desktopAnalyticsConsent" (
  id uuid primary key,
  "tokenHash" text not null unique,
  revision integer not null default 1,
  usage boolean not null,
  diagnostics boolean not null,
  notice text not null,
  "createdAt" timestamptz not null default clock_timestamp(),
  "expiresAt" timestamptz not null,
  "accountId" uuid references "productAnalyticsAccount"(id) on delete set null,
  "challengeHash" text unique,
  "challengeExpiresAt" timestamptz,
  "lastExportAt" timestamptz
);
create index "desktopAnalyticsConsent_expiry" on "desktopAnalyticsConsent" ("expiresAt");
create table "productAnalyticsEvent" (
  id uuid primary key,
  "consentId" uuid references "desktopAnalyticsConsent"(id) on delete cascade,
  "browserConsentId" uuid references "privacyConsent"(id) on delete cascade,
  "accountId" uuid references "productAnalyticsAccount"(id) on delete cascade,
  subject text not null,
  surface text not null check (surface in ('desktop','web')),
  purpose text not null check (purpose in ('usage','diagnostics')),
  name text not null,
  at timestamptz not null,
  "expiresAt" timestamptz not null,
  properties jsonb not null,
  check (("consentId" is null) <> ("browserConsentId" is null))
);
create index "productAnalyticsEvent_expiry" on "productAnalyticsEvent" ("expiresAt");
create index "productAnalyticsEvent_consent" on "productAnalyticsEvent" ("consentId");
create index "productAnalyticsEvent_browser" on "productAnalyticsEvent" ("browserConsentId");
create index "productAnalyticsEvent_activity" on "productAnalyticsEvent" (subject,at) where name='product_active_day';
create unique index "productAnalyticsEvent_active_day" on "productAnalyticsEvent" (subject,surface,((at at time zone 'UTC')::date),(coalesce(properties->>'release','web'))) where name='product_active_day';
create index "productAnalyticsEvent_account" on "productAnalyticsEvent" ("accountId",at) where "accountId" is not null;
create table "desktopDownloadSnapshot" (
  day date not null,
  asset bigint not null,
  release text not null,
  kind text not null check (kind in ('installer','update')),
  downloads bigint not null check (downloads>=0),
  primary key(day,asset)
);
create table "productAnalyticsExport" (
  day date primary key,
  "exportedAt" timestamptz,
  "downloadsAt" timestamptz
);
commit;
