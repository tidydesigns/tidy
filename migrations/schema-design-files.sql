create table "designFile" (
  "id" text not null primary key,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "name" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index "designFile_organizationId_updatedAt_idx" on "designFile" ("organizationId", "updatedAt" desc);

create table "designFrame" (
  "id" text not null primary key,
  "fileId" text not null references "designFile" ("id") on delete cascade,
  "x" integer not null,
  "y" integer not null,
  "width" integer not null,
  "height" integer not null,
  "createdAt" timestamptz not null default now(),
  constraint "designFrame_position_check" check ("x" >= 0 and "y" >= 0),
  constraint "designFrame_size_check" check ("width" between 40 and 5000 and "height" between 40 and 5000)
);

create index "designFrame_fileId_createdAt_idx" on "designFrame" ("fileId", "createdAt");
