-- Apply after organization billing, object storage, and file thumbnails.
begin;

-- This catalog is the single source of truth for both enforcement and the UI.
-- NULL means unlimited. Changing allowances does not require a deployment.
create table "billingPlan" (
  "id" text primary key check ("id" in ('free', 'pro', 'self_hosted')),
  "fileLimit" integer check ("fileLimit" >= 0),
  "editorLimit" integer check ("editorLimit" >= 1),
  "storageLimit" bigint check ("storageLimit" between 0 and 9007199254740991)
);
insert into "billingPlan" values
  ('free', 3, 1, 500000000),
  ('pro', null, null, 10000000000),
  ('self_hosted', null, null, null);
create table "billingDeployment" (
  "id" boolean primary key default true check ("id"),
  "selfHosted" boolean not null default false
);
insert into "billingDeployment" ("id") values (true);
-- Trusted server configuration registers Pro price IDs here. Keep old prices
-- when changing the Stripe catalog so existing subscribers keep their plan.
create table "billingPlanPrice" ("priceId" text primary key);

alter table "designObject" add column "usageKind" text not null default 'asset'
  check ("usageKind" in ('asset', 'thumbnail'));
update "designObject" o set "usageKind" = 'thumbnail'
where exists (select 1 from "designFileThumbnail" t where t."objectKey" = o."objectKey")
  and not exists (select 1 from "designAsset" a where a."objectKey" = o."objectKey")
  and not exists (select 1 from "githubReviewAsset" a where a."objectKey" = o."objectKey")
  and not exists (select 1 from "githubCapture" a where a."objectKey" = o."objectKey");
create index "designObject_organization_usage_idx" on "designObject" ("organizationId", "sha256") where "usageKind" = 'asset';

alter table "invitation" add column "editorReservation" boolean not null default false;

create function "organizationPlan"(org text) returns text language plpgsql stable as $$
declare self_hosted boolean; tier text;
begin
  select "selfHosted" into self_hosted from "billingDeployment" where "id" = true;
  if not found then raise exception 'Plan deployment is not configured.'; end if;
  if self_hosted then tier := 'self_hosted';
  elsif exists (select 1 from "organization_billing" b join "billingPlanPrice" p on p."priceId" = b."stripePriceId"
    where b."organizationId" = org and b."stripeStatus" in ('active', 'trialing')) then tier := 'pro';
  else tier := 'free'; end if;
  if not exists (select 1 from "billingPlan" where "id" = tier) then raise exception 'Plan allowances are not configured.'; end if;
  return tier;
end;
$$;

create function "isEditingRole"(role text) returns boolean language sql immutable as $$
  select coalesce(string_to_array(role, ',') && array['owner', 'admin', 'editor', 'member'], false)
$$;

-- Pending editor invitations reserve a seat. Accepted invitations continue to
-- reserve it while Better Auth creates the member in its subsequent transaction.
-- Members and invitations for the same person count once.
create function "organizationEditors"(org text) returns table (email text) language sql stable as $$
  select lower(u."email") from "member" m join "user" u on u."id" = m."userId"
    where m."organizationId" = org and "isEditingRole"(m."role")
  union select lower(i."email") from "invitation" i where i."organizationId" = org
    and (i."status" = 'pending' or (i."status" = 'accepted' and i."editorReservation")) and i."expiresAt" > now() and "isEditingRole"(i."role")
$$;

-- Deduplicate originals shared with review snapshots. Registry claims reserve
-- capacity before R2 uploads; legacy database-backed originals count too.
-- Generated thumbnails are deliberately excluded.
create function "organizationStorageObjects"(org text) returns table (digest text, bytes bigint) language sql stable as $$
  select digest, max(bytes)::bigint from (
    select o."sha256" digest, o."byteSize" bytes from "designObject" o where o."organizationId" = org and o."usageKind" = 'asset'
    union all select a."sha256", coalesce(octet_length(a."body"), a."byteSize") from "designAsset" a where a."organizationId" = org
    union all select coalesce(a."sha256", encode(sha256(a."body"), 'hex'), o."sha256"),
      coalesce(octet_length(a."body"), a."byteSize", o."byteSize")
      from "githubReviewAsset" a join "githubReview" r on r."id" = a."reviewId"
      left join "designObject" o on o."objectKey" = a."objectKey" where r."organizationId" = org
    union all select a."sha256", coalesce(octet_length(a."body"), a."byteSize")
      from "githubCapture" a join "githubReview" r on r."id" = a."reviewId" where r."organizationId" = org
  ) originals group by digest
$$;

create function "organizationPlanUsage"(org text) returns jsonb language sql stable as $$
  select jsonb_build_object('tier', p."id", 'limits', jsonb_build_object('files', p."fileLimit", 'editors', p."editorLimit", 'storageBytes', p."storageLimit"),
    'usage', jsonb_build_object('files', (select count(*) from "designFile" where "organizationId" = org),
      'editors', (select count(*) from "organizationEditors"(org)),
      'storageBytes', (select coalesce(sum(bytes), 0) from "organizationStorageObjects"(org))))
  from "billingPlan" p where p."id" = "organizationPlan"(org)
$$;

create function "raisePlanLimit"(tier text, resource text, allowance bigint) returns void language plpgsql as $$
begin
  raise exception using errcode = 'P0001',
    message = case resource
      when 'files' then format('%s allows %s files, including archived files. Delete an archived file to create another.%s', initcap(tier), allowance,
        case when tier = 'free' then ' Or upgrade to Pro.' else '' end)
      when 'editors' then format('%s allows %s editor(s), including owners, admins and pending editor invitations. Invite a viewer or reduce editing access.%s', initcap(tier), allowance,
        case when tier = 'free' then ' Upgrade to Pro to include all team members.' else '' end)
      else case when tier = 'free' then 'Free asset storage is full. Upgrade to Pro to upload more.'
        when tier = 'pro' then 'Pro asset storage is full. Contact support for more storage.'
        else 'Asset storage is full. Ask your instance administrator for more capacity.' end end,
    detail = jsonb_build_object('code', 'PLAN_LIMIT', 'resource', resource, 'limit', allowance, 'tier', tier)::text;
end;
$$;

-- All growth checks take the same transaction lock per organization. Queries
-- after the lock see the previous writer's committed usage under READ COMMITTED.
create function "checkEditorCapacity"(org text, candidate text) returns void language plpgsql as $$
declare tier text; allowance integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(org, 0));
  tier := "organizationPlan"(org);
  select "editorLimit" into allowance from "billingPlan" where "id" = tier;
  if allowance is not null and not exists (select 1 from "organizationEditors"(org) where email = lower(candidate))
    and (select count(*) from "organizationEditors"(org)) >= allowance then
    perform "raisePlanLimit"(tier, 'editors', allowance);
  end if;
end;
$$;

create function "enforceFilePlan"() returns trigger language plpgsql as $$
declare tier text; allowance integer;
begin
  if TG_OP = 'UPDATE' and NEW."organizationId" = OLD."organizationId" then return NEW; end if;
  perform pg_advisory_xact_lock(hashtextextended(NEW."organizationId", 0));
  tier := "organizationPlan"(NEW."organizationId");
  select "fileLimit" into allowance from "billingPlan" where "id" = tier;
  if allowance is not null and (select count(*) from "designFile" where "organizationId" = NEW."organizationId") >= allowance then
    perform "raisePlanLimit"(tier, 'files', allowance);
  end if;
  return NEW;
end;
$$;
create trigger "designFile_plan" before insert or update of "organizationId" on "designFile" for each row execute function "enforceFilePlan"();

create function "enforceMemberPlan"() returns trigger language plpgsql as $$
begin
  if not "isEditingRole"(NEW."role") then return NEW; end if;
  if TG_OP = 'UPDATE' and NEW."organizationId" = OLD."organizationId" and NEW."userId" = OLD."userId" and "isEditingRole"(OLD."role") then return NEW; end if;
  perform "checkEditorCapacity"(NEW."organizationId", (select "email" from "user" where "id" = NEW."userId"));
  return NEW;
end;
$$;
create trigger "member_plan" before insert or update of "role", "organizationId", "userId" on "member" for each row execute function "enforceMemberPlan"();

create function "enforceInvitationPlan"() returns trigger language plpgsql as $$
begin
  if NEW."status" = 'accepted' then
    if TG_OP = 'INSERT' then NEW."editorReservation" := true;
    elsif OLD."status" = 'pending' then NEW."editorReservation" := true; end if;
  else NEW."editorReservation" := false; end if;
  if NEW."status" in ('pending', 'accepted') and NEW."expiresAt" > now() and "isEditingRole"(NEW."role") then
    perform "checkEditorCapacity"(NEW."organizationId", NEW."email");
  end if;
  return NEW;
end;
$$;
create trigger "invitation_plan" before insert or update on "invitation" for each row execute function "enforceInvitationPlan"();

-- Complete the handoff from an accepted invitation to a real membership.
-- This prevents accepted links from reserving a seat after a member is removed.
create function "releaseAcceptedEditorReservation"() returns trigger language plpgsql as $$
begin
  update "invitation" set "editorReservation" = false
    where "organizationId" = NEW."organizationId" and "status" = 'accepted' and "editorReservation"
      and lower("email") = (select lower("email") from "user" where "id" = NEW."userId");
  return NEW;
end;
$$;
create trigger "member_release_editor_reservation" after insert on "member" for each row execute function "releaseAcceptedEditorReservation"();

create function "enforceStoragePlan"() returns trigger language plpgsql as $$
declare org text; asset_digest text; asset_bytes bigint; existing bigint; used bigint; allowance bigint; tier text;
begin
  if TG_TABLE_NAME = 'designObject' then
    if NEW."usageKind" = 'thumbnail' then return NEW; end if;
    org := NEW."organizationId"; asset_digest := NEW."sha256"; asset_bytes := NEW."byteSize";
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
create trigger "designObject_plan" before insert or update on "designObject" for each row execute function "enforceStoragePlan"();
create trigger "designAsset_plan" before insert or update on "designAsset" for each row execute function "enforceStoragePlan"();
create trigger "githubReviewAsset_plan" before insert or update on "githubReviewAsset" for each row execute function "enforceStoragePlan"();
create trigger "githubCapture_plan" before insert or update on "githubCapture" for each row execute function "enforceStoragePlan"();
commit;
