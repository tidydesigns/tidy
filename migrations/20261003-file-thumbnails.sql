-- Requires design object storage. Thumbnail bytes are disposable derived data.
begin;
create table if not exists "designFileThumbnail" (
  "fileId" text primary key references "designFile"("id") on delete cascade,
  "version" text not null,
  "mimeType" text not null default 'image/png',
  "sha256" text not null,
  "objectKey" text,
  "byteSize" bigint not null,
  "body" bytea,
  check ("body" is not null or "objectKey" is not null)
);
create index if not exists "designFileThumbnail_object_idx" on "designFileThumbnail" ("objectKey") where "objectKey" is not null;
commit;
