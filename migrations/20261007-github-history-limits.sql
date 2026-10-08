-- Retained-history accounting only: preserve every legacy row and image.
-- Apply before deploying history admission. No RLS policies or broad grants.
begin;
alter table "githubReview" add column if not exists "retainedBytes" bigint
  generated always as (octet_length("content"::text)::bigint + octet_length("frameIds"::text) + 8192) stored;
alter table "githubReviewAsset" add column if not exists "retainedBytes" bigint
  generated always as (greatest(coalesce("byteSize",0),coalesce(octet_length("body"),0))
    + octet_length("assetId") + 512) stored;
alter table "githubCapture" add column if not exists "retainedBytes" bigint
  generated always as (greatest(coalesce("byteSize",0),coalesce(octet_length("body"),0))
    + octet_length("frameId") + octet_length("route") + 512) stored;
alter table "githubFeedback" add column if not exists "retainedBytes" bigint
  generated always as (octet_length("body")::bigint + coalesce(octet_length("response"),0)
    + coalesce(octet_length("nodeId"),0) + coalesce(octet_length("point"::text),0) + 512) stored;
create index if not exists "githubReview_organization_history_idx"
  on "githubReview" ("organizationId","fileId","id") include ("retainedBytes");
commit;
