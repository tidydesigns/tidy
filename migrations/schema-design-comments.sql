-- Apply after schema-design-files.sql, through an approved database change.
create table "designCommentThread" (
  "id" text primary key,
  "fileId" text not null references "designFile" ("id") on delete cascade,
  "x" integer not null check ("x" between -100000 and 100000),
  "y" integer not null check ("y" between -100000 and 100000),
  "createdBy" text not null references "user" ("id"),
  "createdAt" timestamptz not null default now()
);

create index "designCommentThread_fileId_createdAt_idx" on "designCommentThread" ("fileId", "createdAt");

create table "designCommentMessage" (
  "id" text primary key,
  "threadId" text not null references "designCommentThread" ("id") on delete cascade,
  "authorId" text not null references "user" ("id"),
  "body" text not null check (char_length("body") between 1 and 2000),
  "createdAt" timestamptz not null default now()
);

create index "designCommentMessage_threadId_createdAt_idx" on "designCommentMessage" ("threadId", "createdAt");
