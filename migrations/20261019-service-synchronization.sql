begin;

alter table "organization_billing" add column "lastReconciledAt" timestamptz;
create index "organization_billing_reconciliation_idx"
  on "organization_billing" ("lastReconciledAt" nulls first, "organizationId")
  where "stripeSubscriptionId" is not null and "stripeStatus" in ('active','trialing','past_due','unpaid','incomplete','paused');

create index "githubReview_pull_lookup_idx"
  on "githubReview" ("installationId", "repositoryId", "number", "id");

-- Retain a one-day renewal grace period while the canonical state catches up.
-- Existing rows without a period have a one-day transition from their last write.
create or replace function "organizationPlan"(org text) returns text language plpgsql stable as $$
declare self_hosted boolean; tier text;
begin
  select "selfHosted" into self_hosted from "billingDeployment" where "id" = true;
  if not found then raise exception 'Plan deployment is not configured.'; end if;
  if self_hosted then tier := 'self_hosted';
  elsif exists (select 1 from "organization_billing" b join "billingPlanPrice" p on p."priceId" = b."stripePriceId"
    where b."organizationId" = org and b."stripeStatus" in ('active', 'trialing')
      and coalesce(b."currentPeriodEnd", b."updatedAt") + interval '24 hours' > now()) then tier := 'pro';
  else tier := 'free'; end if;
  if not exists (select 1 from "billingPlan" where "id" = tier) then raise exception 'Plan allowances are not configured.'; end if;
  return tier;
end;
$$;

commit;
