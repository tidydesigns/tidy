-- Requires schema.sql, schema-organization.sql, schema-design-files.sql and schema-design-folders.sql.
-- Provider credentials are personal, encrypted, and never organisation Vault entries.
create table "agentConnection" (
  "id" uuid primary key,
  "userId" text not null unique references "user"("id") on delete cascade,
  "provider" text not null default 'codex' check ("provider" in ('codex','chatgpt')),
  "subject" text not null,
  "clientId" text not null,
  "accountLabel" text not null,
  "encryptedTokens" jsonb,
  "scopes" text[] not null default '{}',
  "status" text not null check ("status" in ('connecting','connected','identity_only','reconnect','disconnected')),
  "expiresAt" timestamptz,
  "version" integer not null default 1,
  "updatedAt" timestamptz not null default now()
);

create table "agentOAuthAttempt" (
  "stateHash" text primary key,
  "userId" text not null references "user"("id") on delete cascade,
  "sessionId" text not null references "session"("id") on delete cascade,
  "encryptedTransaction" jsonb not null,
  "expiresAt" timestamptz not null
);
create index "agentOAuthAttempt_expiry" on "agentOAuthAttempt"("expiresAt");

create table "agentThread" (
  "id" uuid primary key,
  "organizationId" text not null references "organization"("id") on delete cascade,
  "createdBy" text references "user"("id") on delete set null,
  "title" text not null check (char_length("title") between 1 and 120),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "sequence" bigint not null default 0
);
create index "agentThread_org_updated" on "agentThread"("organizationId","updatedAt" desc,"id");
create table "agentThreadFile" (
  "threadId" uuid not null references "agentThread"("id") on delete cascade,
  "fileId" text not null references "designFile"("id") on delete cascade,
  "selectedNodeIds" text[] not null default '{}',
  primary key ("threadId","fileId")
);

create table "agentRun" (
  "id" uuid primary key,
  "threadId" uuid not null references "agentThread"("id") on delete cascade,
  "ownerId" text not null references "user"("id") on delete cascade,
  "connectionId" uuid not null references "agentConnection"("id") on delete cascade,
  "requestId" uuid not null,
  "requestHash" text not null,
  "agentLimit" integer not null check ("agentLimit" between 1 and 6),
  "model" text not null,
  "status" text not null default 'queued' check ("status" in ('queued','running','waiting','recovering','limited','completed','cancelled','failed')),
  "reason" text,
  "generation" integer not null default 0,
  "leaseOwner" text,
  "leaseExpiresAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "finishedAt" timestamptz,
  unique ("ownerId","requestId")
);
create unique index "agentRun_one_active_thread" on "agentRun"("threadId")
  where "status" in ('queued','running','waiting','recovering','limited');
create index "agentRun_queue" on "agentRun"("status","createdAt");
create index "agentRun_owner" on "agentRun"("ownerId","status");

create table "agentWorker" (
  "id" uuid primary key,
  "runId" uuid not null references "agentRun"("id") on delete cascade,
  "parentId" uuid references "agentWorker"("id") on delete cascade,
  "name" text not null check (char_length("name") between 1 and 80),
  "task" text not null,
  "status" text not null default 'queued' check ("status" in ('queued','working','waiting','completed','failed','cancelled')),
  "runtimeThreadId" text,
  "fileId" text references "designFile"("id") on delete set null,
  "nodeIds" text[] not null default '{}',
  "heartbeatAt" timestamptz,
  "attempt" integer not null default 0
);
create index "agentWorker_run" on "agentWorker"("runId");

create table "agentMessage" (
  "id" uuid primary key,
  "threadId" uuid not null references "agentThread"("id") on delete cascade,
  "runId" uuid references "agentRun"("id") on delete cascade,
  "agentId" uuid references "agentWorker"("id") on delete cascade,
  "userId" text references "user"("id") on delete set null,
  "kind" text not null check ("kind" in ('user','assistant','instruction','question','system')),
  "content" text not null check (octet_length("content") <= 262144),
  "delivery" text not null default 'delivered' check ("delivery" in ('pending','delivered','interrupted')),
  "requestId" uuid,
  "sequence" bigint not null,
  "createdAt" timestamptz not null default now(),
  unique ("threadId","sequence"),
  unique ("userId","requestId")
);

-- This is also the durable outbox. Sequence allocation holds the thread row lock
-- until commit, so replay cursors cannot skip a late-committing event.
create table "agentEvent" (
  "threadId" uuid not null references "agentThread"("id") on delete cascade,
  "sequence" bigint not null,
  "type" text not null,
  "payload" jsonb not null,
  "createdAt" timestamptz not null default now(),
  primary key ("threadId","sequence")
);

create table "agentToolOperation" (
  "runId" uuid not null references "agentRun"("id") on delete cascade,
  "callId" text not null,
  "agentId" uuid not null references "agentWorker"("id") on delete cascade,
  "tool" text not null,
  "inputHash" text not null,
  "result" jsonb,
  "status" text not null check ("status" in ('started','completed','uncertain')),
  "createdAt" timestamptz not null default now(),
  primary key ("runId","callId")
);

create table "agentReservation" (
  "fileId" text not null references "designFile"("id") on delete cascade,
  "targetId" text not null,
  "agentId" uuid not null references "agentWorker"("id") on delete cascade,
  "expiresAt" timestamptz not null,
  primary key ("fileId","targetId")
);
