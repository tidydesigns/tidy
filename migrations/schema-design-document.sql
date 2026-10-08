-- Apply only to an approved database. Existing frame and rectangle tables stay intact.
create table if not exists "designDocument" (
  "fileId" text primary key references "designFile" ("id") on delete cascade,
  "revision" integer not null default 1,
  "content" jsonb not null,
  "updatedAt" timestamptz not null default now()
);

create table if not exists "designAsset" (
  "id" text primary key,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "mimeType" text not null,
  "sha256" text not null,
  "body" bytea not null,
  "createdAt" timestamptz not null default now(),
  unique ("organizationId", "sha256")
);

create table if not exists "designImport" (
  "id" text primary key,
  "userId" text not null references "user" ("id"),
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "fileId" text references "designFile" ("id") on delete cascade,
  "name" text not null,
  "expectedRevision" integer,
  "chunks" jsonb not null default '{}'::jsonb,
  "status" text not null default 'staging',
  "committedRevision" integer,
  "createdAt" timestamptz not null default now(),
  "expiresAt" timestamptz not null default (now() + interval '24 hours')
);

create index if not exists "designImport_userId_status_idx" on "designImport" ("userId", "status");
