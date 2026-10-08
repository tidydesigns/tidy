-- Apply after organization schema and 20261003-plan-limits.sql.
begin;

alter table "organization" add column "createdByUserId" text references "user" ("id") on delete set null;
-- Historical creators weren't recorded. Attribute existing organizations to
-- their earliest remaining owner; review this attribution before rollout.
update "organization" o set "createdByUserId" = (
  select m."userId" from "member" m where m."organizationId" = o."id"
    and 'owner' = any(string_to_array(m."role", ','))
  order by m."createdAt", m."id" limit 1
);
create index "organization_creator_idx" on "organization" ("createdByUserId");

-- Operator-managed permission; never a user-editable profile or client flag.
create table "organizationCreationPermission" (
  "userId" text primary key references "user" ("id") on delete cascade,
  "allowMultiple" boolean not null default false
);
-- Bootstrap the existing developer account by its stable ID, not its email.
insert into "organizationCreationPermission" ("userId", "allowMultiple")
select "id", true from "user" where "id" = 'zqMKiWaydNsof6qrNOZxMVCyfmubFEkt';

create function "canCreateOrganization"(creator text) returns boolean language plpgsql stable as $$
declare self_hosted boolean;
begin
  select "selfHosted" into self_hosted from "billingDeployment" where "id" = true;
  if not found then raise exception 'Plan deployment is not configured.'; end if;
  return self_hosted
    or exists (select 1 from "organizationCreationPermission" where "userId" = creator and "allowMultiple")
    or not exists (select 1 from "organization" where "createdByUserId" = creator);
end;
$$;

create function "enforceOrganizationCreation"() returns trigger language plpgsql as $$
begin
  if TG_OP = 'UPDATE' then
    if NEW."createdByUserId" is not distinct from OLD."createdByUserId" then return NEW; end if;
    -- Allow the FK to clear attribution when its user account is deleted.
    if NEW."createdByUserId" is null and not exists (select 1 from "user" where "id" = OLD."createdByUserId") then return NEW; end if;
    raise exception 'Organization creator cannot be changed.' using errcode = '23514';
  end if;
  if NEW."createdByUserId" is null then raise exception 'Organization creator is required.' using errcode = '23514'; end if;
  perform pg_advisory_xact_lock(hashtextextended('organization-creator:' || NEW."createdByUserId", 0));
  if not "canCreateOrganization"(NEW."createdByUserId") then
    raise exception using errcode = 'P0001',
      message = 'You can create one organization. You can still join other organizations by invitation.',
      detail = '{"code":"ORGANIZATION_CREATION_LIMIT"}';
  end if;
  return NEW;
end;
$$;
create trigger "organization_creation_limit" before insert or update of "createdByUserId" on "organization"
  for each row execute function "enforceOrganizationCreation"();
commit;
