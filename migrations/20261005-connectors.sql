-- Requires schema.sql and schema-organization.sql. Apply only to an approved database.
-- Credentials are personal; linking an account never grants other members its access.
create table "connectorAccount" (
  "id" uuid primary key,
  "provider" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "externalWorkspaceId" text not null,
  "externalUserId" text not null,
  "workspaceName" text not null,
  "accountName" text not null,
  "credentials" jsonb,
  "scopes" text[] not null,
  "expiresAt" timestamptz not null,
  "state" text not null default 'connected' check ("state" in ('connected', 'reconnect')),
  "updatedAt" timestamptz not null default now(),
  unique ("provider", "userId", "externalWorkspaceId")
);

create table "connectorConnection" (
  "id" uuid primary key,
  "accountId" uuid not null references "connectorAccount" ("id") on delete cascade,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "createdAt" timestamptz not null default now(),
  unique ("organizationId", "accountId")
);

create table "connectorOAuthState" (
  "hash" text primary key,
  "provider" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "accountId" uuid references "connectorAccount" ("id") on delete cascade,
  "verifier" jsonb not null,
  "expiresAt" timestamptz not null
);
create index "connectorOAuthState_expiry_idx" on "connectorOAuthState" ("expiresAt");
create index "connectorConnection_account_idx" on "connectorConnection" ("accountId");
create index "connectorAccount_workspace_idx" on "connectorAccount" ("provider", "externalWorkspaceId");

create table "connectorWebhookDelivery" (
  "provider" text not null,
  "id" text not null,
  "createdAt" timestamptz not null default now(),
  primary key ("provider", "id")
);

-- External mutations have a stable operation key; ambiguous successes are never blindly repeated.
create table "connectorOperation" (
  "id" uuid primary key,
  "connectionId" uuid not null references "connectorConnection" ("id") on delete cascade,
  "kind" text not null,
  "inputHash" text not null,
  "state" text not null check ("state" in ('pending', 'succeeded', 'uncertain')),
  "result" jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
