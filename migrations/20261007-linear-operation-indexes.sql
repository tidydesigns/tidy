-- Index the bounded account/state/operation admission paths. No production execution implied.
create index if not exists "connectorOperation_connection_created_idx"
  on "connectorOperation" ("connectionId", "createdAt");
create index if not exists "connectorOAuthState_user_organization_expiry_idx"
  on "connectorOAuthState" ("userId", "organizationId", "expiresAt");
