create table "designFolder" (
  "id" text not null primary key,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "name" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint "designFolder_id_organizationId_unique" unique ("id", "organizationId")
);

create index "designFolder_organizationId_name_idx" on "designFolder" ("organizationId", "name");

alter table "designFile" add column "folderId" text;
alter table "designFile" add column "archivedAt" timestamptz;
alter table "designFile" add constraint "designFile_folderId_organizationId_fkey"
  foreign key ("folderId", "organizationId") references "designFolder" ("id", "organizationId");

create index "designFile_organizationId_folderId_archivedAt_idx"
  on "designFile" ("organizationId", "folderId", "archivedAt", "updatedAt" desc);
