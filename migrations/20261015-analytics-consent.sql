-- Apply after 20261011-account-privacy.sql; reapply runtime-grants.sql afterwards.
begin;
create table "privacyConsent" (
  id uuid primary key,
  "tokenHash" text not null,
  "browserId" uuid not null,
  "userId" text references "user"(id) on delete cascade,
  version integer not null,
  "noticeVersion" text not null,
  at bigint not null,
  analytics boolean not null,
  replay boolean not null,
  diagnostics boolean not null,
  "recordedAt" timestamptz not null default clock_timestamp(),
  "expiresAt" timestamptz not null,
  "retiredAt" timestamptz
);
create index "privacyConsent_token" on "privacyConsent" ("tokenHash", "recordedAt" desc);
create index "privacyConsent_user" on "privacyConsent" ("userId", "browserId");
create index "privacyConsent_expiry" on "privacyConsent" ("expiresAt") where "retiredAt" is null;
alter table "privacyCleanup" drop constraint "privacyCleanup_kind_check";
alter table "privacyCleanup" add constraint "privacyCleanup_kind_check"
  check (kind in ('avatar','feedback','runner','posthog','posthog-review'));
-- Minimal evidence after an operator verifies removal; no raw customer identifier.
create table "privacyCleanupReceipt" (
  id uuid primary key,
  kind text not null,
  "subjectHash" text not null,
  reference text not null check (char_length(reference) between 1 and 500),
  "completedAt" timestamptz not null default now()
);
commit;
