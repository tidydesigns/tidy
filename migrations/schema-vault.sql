create table "vaultLogin" ("id" text not null primary key, "userId" text not null references "user" ("id") on delete cascade, "name" text not null, "ciphertext" text not null, "iv" text not null, "authTag" text not null, "keyVersion" integer not null, "createdAt" timestamptz not null);

create index "vaultLogin_userId_idx" on "vaultLogin" ("userId");
