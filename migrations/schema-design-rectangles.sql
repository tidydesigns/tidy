create table "designRectangle" (
  "id" text not null primary key,
  "fileId" text not null references "designFile" ("id") on delete cascade,
  "x" integer not null,
  "y" integer not null,
  "width" integer not null,
  "height" integer not null,
  "createdAt" timestamptz not null default now(),
  constraint "designRectangle_position_check" check ("x" between 0 and 100000 and "y" between 0 and 100000),
  constraint "designRectangle_size_check" check ("width" between 1 and 5000 and "height" between 1 and 5000)
);

create index "designRectangle_fileId_createdAt_idx" on "designRectangle" ("fileId", "createdAt");
