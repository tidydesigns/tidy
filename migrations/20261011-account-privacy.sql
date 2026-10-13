-- Prepare only; apply to an explicitly approved target before deployment.
begin;
-- Shared work retains a single, non-authenticating anonymous attribution.
insert into "user" (id,name,email,"emailVerified")
values ('tidy-deleted-user','Deleted user','deleted-user@tidy.invalid',false);

-- No foreign key: cleanup must survive deletion of the original account.
create table "privacyCleanup" (
  id uuid primary key,
  kind text not null check (kind in ('avatar','feedback','runner','posthog')),
  subject text not null,
  "createdAt" timestamptz not null default now(),
  "nextAttemptAt" timestamptz not null default now(),
  attempts integer not null default 0
);
create index "privacyCleanup_pending" on "privacyCleanup" ("nextAttemptAt");
-- Feedback is a requested service, independent of optional analytics consent.
create table "feedbackSubmission" (
  id uuid primary key,
  "userId" text not null references "user"(id) on delete cascade,
  category text not null check (category in ('broken','general')),
  message text not null check (char_length(message) between 1 and 10000),
  "createdAt" timestamptz not null default now()
);
create index "feedbackSubmission_user" on "feedbackSubmission" ("userId","createdAt");
commit;
