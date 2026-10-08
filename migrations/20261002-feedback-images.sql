-- Requires schema.sql. Image bytes live in private R2, never in Postgres.
create table "feedbackUpload" (
  "id" uuid primary key,
  "userId" text not null references "user"("id") on delete cascade,
  "fingerprint" text not null,
  "attachments" jsonb not null,
  "createdAt" timestamptz not null default now()
);
create index "feedbackUpload_user_created" on "feedbackUpload" ("userId", "createdAt");
