-- Prepare locally; apply only to an explicitly approved database.
begin;
create table "githubUser" (
  "userId" text primary key references "user"("id") on delete cascade,
  "githubId" bigint not null,
  "login" text not null,
  "credentials" jsonb not null,
  "expiresAt" timestamptz,
  "refreshExpiresAt" timestamptz
);
create table "githubOAuthState" (
  "hash" text primary key,
  "userId" text not null references "user"("id") on delete cascade,
  "organizationId" text not null references "organization"("id") on delete cascade,
  "verifier" jsonb not null,
  "expiresAt" timestamptz not null
);
create table "githubConnection" (
  "organizationId" text not null references "organization"("id") on delete cascade,
  "installationId" bigint not null,
  "account" text not null,
  "active" boolean not null default true,
  primary key ("organizationId", "installationId")
);
create table "githubReview" (
  "id" text primary key,
  "fileId" text not null references "designFile"("id") on delete cascade,
  "organizationId" text not null,
  "installationId" bigint not null,
  "repositoryId" bigint not null,
  "repository" text not null,
  "number" integer not null check ("number" > 0),
  "title" text not null,
  "url" text not null,
  "state" text not null,
  "branch" text not null,
  "baseSha" text not null,
  "headSha" text not null,
  "linkedSha" text not null,
  "revision" integer not null,
  "frameIds" jsonb not null,
  "frameKey" text not null,
  "content" jsonb not null,
  "createdBy" text not null references "user"("id"),
  "createdAt" timestamptz not null default now(),
  foreign key ("organizationId", "installationId") references "githubConnection"("organizationId", "installationId"),
  unique ("fileId", "repositoryId", "number", "revision", "frameKey")
);
create index "githubReview_file_idx" on "githubReview"("fileId", "createdAt");
create table "githubReviewAsset" (
  "reviewId" text not null references "githubReview"("id") on delete cascade,
  "assetId" text not null,
  "mimeType" text not null,
  "body" bytea not null,
  primary key ("reviewId", "assetId")
);
create table "githubCapture" (
  "id" text primary key,
  "reviewId" text not null references "githubReview"("id") on delete cascade,
  "frameId" text not null,
  "sha" text not null,
  "route" text not null,
  "width" integer not null check ("width" between 1 and 5000),
  "height" integer not null check ("height" between 1 and 5000),
  "mimeType" text not null,
  "body" bytea not null,
  "sha256" text not null,
  "createdAt" timestamptz not null default now(),
  unique ("reviewId", "frameId", "sha", "route", "width", "height", "sha256")
);
create table "githubFeedback" (
  "id" text primary key,
  "reviewId" text not null references "githubReview"("id") on delete cascade,
  "captureId" text references "githubCapture"("id"),
  "nodeId" text,
  "point" jsonb,
  "sha" text not null,
  "body" text not null check (char_length("body") between 1 and 2000),
  "authorId" text not null references "user"("id"),
  "status" text not null default 'open' check ("status" in ('open', 'proposed', 'verified')),
  "response" text,
  "fixSha" text,
  "githubCommentId" bigint,
  "createdAt" timestamptz not null default now()
);
create index "githubFeedback_review_idx" on "githubFeedback"("reviewId", "createdAt");
create table "githubWebhookDelivery" (
  "id" text primary key,
  "createdAt" timestamptz not null default now()
);
commit;
