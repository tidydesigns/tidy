create table "organization_billing" (
  "organizationId" text primary key references "organization" ("id") on delete cascade,
  "stripeCustomerId" text unique,
  "stripeSubscriptionId" text unique,
  "stripeCheckoutSessionId" text unique,
  "stripeStatus" text,
  "stripePriceId" text,
  "currentPeriodEnd" timestamptz,
  "cancelAtPeriodEnd" boolean not null default false,
  "firstMonthUsed" boolean not null default false,
  "updatedAt" timestamptz not null default now()
);
