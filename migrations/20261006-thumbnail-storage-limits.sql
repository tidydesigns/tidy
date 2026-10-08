-- Count every retained original, including thumbnail claims and legacy thumbnail blobs.
-- Existing files remain readable if historical usage is already above the plan.
-- Apply through the approved production migration workflow.
begin;
create or replace function "organizationStorageObjects"(org text) returns table (digest text, bytes bigint) language sql stable as $$
  select digest, max(bytes)::bigint from (
    select o."sha256" digest, o."byteSize" bytes from "designObject" o where o."organizationId" = org
    union all select a."sha256", coalesce(octet_length(a."body"), a."byteSize") from "designAsset" a where a."organizationId" = org
    union all select coalesce(a."sha256", encode(sha256(a."body"), 'hex'), o."sha256"),
      coalesce(octet_length(a."body"), a."byteSize", o."byteSize")
      from "githubReviewAsset" a join "githubReview" r on r."id" = a."reviewId"
      left join "designObject" o on o."objectKey" = a."objectKey" where r."organizationId" = org
    union all select a."sha256", coalesce(octet_length(a."body"), a."byteSize")
      from "githubCapture" a join "githubReview" r on r."id" = a."reviewId" where r."organizationId" = org
    union all select t."sha256", coalesce(octet_length(t."body"), t."byteSize")
      from "designFileThumbnail" t join "designFile" f on f."id"=t."fileId" where f."organizationId"=org
  ) originals group by digest
$$;

create or replace function "enforceStoragePlan"() returns trigger language plpgsql as $$
declare org text; asset_digest text; asset_bytes bigint; existing bigint; used bigint; allowance bigint; tier text;
begin
  if TG_TABLE_NAME = 'designObject' then
    org := NEW."organizationId"; asset_digest := NEW."sha256"; asset_bytes := NEW."byteSize";
  elsif TG_TABLE_NAME = 'designFileThumbnail' then
    select "organizationId" into org from "designFile" where "id"=NEW."fileId";
    asset_digest := NEW."sha256"; asset_bytes := coalesce(octet_length(NEW."body"), NEW."byteSize");
  elsif TG_TABLE_NAME = 'designAsset' then
    org := NEW."organizationId"; asset_digest := NEW."sha256"; asset_bytes := coalesce(octet_length(NEW."body"), NEW."byteSize");
  else
    select "organizationId" into org from "githubReview" where "id" = NEW."reviewId";
    asset_digest := coalesce(NEW."sha256", encode(sha256(NEW."body"), 'hex'));
    asset_bytes := coalesce(octet_length(NEW."body"), NEW."byteSize");
    if asset_digest is null or asset_bytes is null then
      select "sha256", "byteSize" into asset_digest, asset_bytes from "designObject" where "objectKey" = NEW."objectKey";
    end if;
  end if;
  if asset_digest is null or asset_bytes is null or asset_bytes < 0 then raise exception 'Asset storage metadata is missing or invalid.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(org, 0));
  tier := "organizationPlan"(org);
  select "storageLimit" into allowance from "billingPlan" where "id" = tier;
  if allowance is null then return NEW; end if;
  select coalesce(max(o.bytes), 0) into existing from "organizationStorageObjects"(org) o where o.digest = asset_digest;
  if asset_bytes > existing then
    select coalesce(sum(o.bytes), 0) into used from "organizationStorageObjects"(org) o;
    if used + asset_bytes - existing > allowance then perform "raisePlanLimit"(tier, 'storage', allowance); end if;
  end if;
  return NEW;
end;
$$;
create trigger "designFileThumbnail_plan" before insert or update on "designFileThumbnail"
  for each row execute function "enforceStoragePlan"();
commit;
